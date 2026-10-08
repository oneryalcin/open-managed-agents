#!/usr/bin/env python3
"""Hosted parity probe (#245): a second user.message sent while a turn runs.

Does hosted Managed Agents reject it, queue it behind the running turn, or
start a parallel turn? And does session.status_idle ever fire while work is
still live?
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

import anthropic


MODEL = os.environ.get("OMA_MID_TURN_PROBE_MODEL", "claude-sonnet-5")
RUN_ID = f"{int(time.time())}-{os.getpid()}"
MARKER_A = f"OMA_MID_TURN_A_{RUN_ID}"
MARKER_B = f"OMA_MID_TURN_B_{RUN_ID}"


def public(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [public(item) for item in value]
    if isinstance(value, dict):
        return {str(key): public(val) for key, val in value.items()}
    if hasattr(value, "model_dump"):
        return public(value.model_dump())
    return repr(value)


def error_shape(exc: BaseException) -> dict[str, Any]:
    return {
        "exception": type(exc).__name__,
        "status_code": getattr(exc, "status_code", None),
        "message": str(exc)[:1000],
        "body": public(getattr(exc, "body", None)),
    }


def user_message(text: str) -> dict[str, Any]:
    return {"type": "user.message", "content": [{"type": "text", "text": text}]}


def send(client: anthropic.Anthropic, session_id: str, events: list[dict[str, Any]]) -> dict[str, Any]:
    started = time.time()
    try:
        result = client.beta.sessions.events.send(session_id, events=events)
        return {"ok": True, "at": started, "response": public(result)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "at": started, "error": error_shape(exc)}


def list_events(client: anthropic.Anthropic, session_id: str) -> list[dict[str, Any]]:
    return [public(event) for event in client.beta.sessions.events.list(session_id)]


def summarize(event: dict[str, Any]) -> dict[str, Any]:
    text = ""
    for block in event.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "text":
            text += block.get("text", "")
    if event.get("type") == "agent.tool_use":
        text = json.dumps(event.get("input"))[:160]
    out = {"type": event.get("type"), "processed_at": event.get("processed_at")}
    if text:
        out["text"] = text[:200]
    if event.get("stop_reason") is not None:
        out["stop_reason"] = event.get("stop_reason")
    return out


def wait_status(client: anthropic.Anthropic, session_id: str, want: str, timeout: float) -> list[str]:
    deadline = time.monotonic() + timeout
    seen: list[str] = []
    while time.monotonic() < deadline:
        status = str(client.beta.sessions.retrieve(session_id).status)
        if not seen or seen[-1] != status:
            seen.append(status)
        if status == want:
            return seen
        time.sleep(0.5)
    raise TimeoutError(f"never reached {want}: {seen}")


def wait_tool_use(client: anthropic.Anthropic, session_id: str, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if any(e.get("type") == "agent.tool_use" for e in list_events(client, session_id)):
            return
        time.sleep(0.5)
    raise TimeoutError("agent never issued a tool_use")


def wait_settled(client: anthropic.Anthropic, session_id: str, timeout: float) -> list[str]:
    """Poll status until idle and the event count is stable for 15s."""
    deadline = time.monotonic() + timeout
    statuses: list[str] = []
    stable_since: float | None = None
    last_count = -1
    while time.monotonic() < deadline:
        status = str(client.beta.sessions.retrieve(session_id).status)
        if not statuses or statuses[-1] != status:
            statuses.append(status)
        count = len(list_events(client, session_id))
        if status != "running" and count == last_count:
            stable_since = stable_since or time.monotonic()
            if time.monotonic() - stable_since > 15:
                return statuses
        else:
            stable_since = None
        last_count = count
        time.sleep(1)
    statuses.append("TIMEOUT")
    return statuses


def scenario(client: anthropic.Anthropic, agent_id: str, env_id: str, name: str, during: str) -> dict[str, Any]:
    """during = 'tool' (B sent while bash sleeps) or 'immediate' (B right after A)."""
    session = client.beta.sessions.create(
        agent=agent_id, environment_id=env_id, title=f"oma-mid-turn-{name}-{RUN_ID}"
    )
    result: dict[str, Any] = {"session_id": session.id}
    try:
        result["send_a"] = send(client, session.id, [user_message(
            f"Use bash exactly once and run: sleep 25; printf '{MARKER_A}\\n'. "
            "Then reply with the printed line only."
        )])
        if during == "tool":
            wait_tool_use(client, session.id, 90)
        result["status_before_b"] = str(client.beta.sessions.retrieve(session.id).status)
        result["send_b"] = send(client, session.id, [user_message(
            f"Reply with exactly: {MARKER_B}"
        )])
        result["status_after_b"] = str(client.beta.sessions.retrieve(session.id).status)
        result["statuses"] = wait_settled(client, session.id, 240)
        events = list_events(client, session.id)
        result["events"] = [summarize(e) for e in events]
        types = [e.get("type") for e in events]
        result["idle_count"] = types.count("session.status_idle")
        result["running_count"] = types.count("session.status_running")
        result["user_message_count"] = types.count("user.message")
        result["system_types"] = sorted({t for t in types if str(t).startswith("system.")})
        return result
    finally:
        try:
            client.beta.sessions.events.send(session.id, events=[{"type": "user.interrupt"}])
        except Exception:
            pass
        try:
            wait_status(client, session.id, "idle", 30)
            client.beta.sessions.delete(session.id)
        except Exception as exc:  # noqa: BLE001
            result["cleanup_error"] = error_shape(exc)


def main() -> None:
    client = anthropic.Anthropic()
    agent_id: str | None = None
    env_id: str | None = None
    findings: dict[str, Any] = {"run_id": RUN_ID, "model": MODEL}
    try:
        env = client.beta.environments.create(
            name=f"oma-mid-turn-env-{RUN_ID}",
            config={"type": "cloud", "networking": {"type": "unrestricted"}},
        )
        env_id = env.id
        agent = client.beta.agents.create(
            name=f"oma-mid-turn-agent-{RUN_ID}",
            model=MODEL,
            system="Follow instructions literally. Use bash only when asked.",
            tools=[{
                "type": "agent_toolset_20260401",
                "default_config": {"enabled": True, "permission_policy": {"type": "always_allow"}},
            }],
        )
        agent_id = agent.id
        findings["during_tool"] = scenario(client, agent_id, env_id, "tool", "tool")
        findings["immediate"] = scenario(client, agent_id, env_id, "immediate", "immediate")
        print(json.dumps(findings, indent=2, sort_keys=True, default=str))
    finally:
        if agent_id:
            try:
                client.beta.agents.archive(agent_id)
            except Exception:
                pass
        if env_id:
            try:
                client.beta.environments.delete(env_id)
            except Exception:
                pass


if __name__ == "__main__":
    main()
