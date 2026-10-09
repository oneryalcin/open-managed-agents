#!/usr/bin/env python3
"""Hosted parity probe (0145 M2, usage metering): session.usage.

Is session.usage the sum of span.model_request_end.model_usage? When does it
update (during a running turn, or only at idle)? Is it cumulative across turns,
present on sessions.list, and what does cache_creation look like when non-zero?
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

import anthropic


MODEL = os.environ.get("OMA_USAGE_PROBE_MODEL", "claude-sonnet-5")
RUN_ID = f"{int(time.time())}-{os.getpid()}"
# Long, stable system prompt so prompt caching has something to write/read.
SYSTEM = (
    "Follow instructions literally. Use bash only when asked.\n\n"
    + "\n".join(f"Reference line {i}: the quick brown fox jumps over the lazy dog." for i in range(400))
)


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


def user_message(text: str) -> dict[str, Any]:
    return {"type": "user.message", "content": [{"type": "text", "text": text}]}


def usage_of(client: anthropic.Anthropic, session_id: str) -> Any:
    return public(client.beta.sessions.retrieve(session_id).usage)


def span_usages(client: anthropic.Anthropic, session_id: str) -> list[dict[str, Any]]:
    return [
        public(e).get("model_usage")
        for e in client.beta.sessions.events.list(session_id)
        if public(e).get("type") == "span.model_request_end"
    ]


def span_sum(spans: list[dict[str, Any]]) -> dict[str, int]:
    keys = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
    return {k: sum((s or {}).get(k) or 0 for s in spans) for k in keys}


def run_turn(client: anthropic.Anthropic, session_id: str, text: str, timeout: float) -> list[dict[str, Any]]:
    """Send a message; sample (status, usage) every 0.5s until idle."""
    client.beta.sessions.events.send(session_id, events=[user_message(text)])
    samples: list[dict[str, Any]] = []
    deadline = time.monotonic() + timeout
    seen_running = False
    while time.monotonic() < deadline:
        s = client.beta.sessions.retrieve(session_id)
        status = str(s.status)
        sample = {"t": round(time.monotonic(), 1), "status": status, "usage": public(s.usage)}
        if not samples or samples[-1]["status"] != status or samples[-1]["usage"] != sample["usage"]:
            samples.append(sample)
        seen_running = seen_running or status == "running"
        if seen_running and status == "idle":
            time.sleep(3)
            samples.append({"after_idle_3s": True, "usage": usage_of(client, session_id)})
            return samples
        time.sleep(0.5)
    samples.append({"timeout": True})
    return samples


def main() -> None:
    client = anthropic.Anthropic()
    agent_id: str | None = None
    env_id: str | None = None
    session_id: str | None = None
    findings: dict[str, Any] = {"run_id": RUN_ID, "model": MODEL}
    try:
        env = client.beta.environments.create(
            name=f"oma-usage-env-{RUN_ID}",
            config={"type": "cloud", "networking": {"type": "unrestricted"}},
        )
        env_id = env.id
        agent = client.beta.agents.create(
            name=f"oma-usage-agent-{RUN_ID}",
            model=MODEL,
            system=SYSTEM,
            tools=[{
                "type": "agent_toolset_20260401",
                "default_config": {"enabled": True, "permission_policy": {"type": "always_allow"}},
            }],
        )
        agent_id = agent.id
        session = client.beta.sessions.create(
            agent=agent_id, environment_id=env_id, title=f"oma-usage-{RUN_ID}"
        )
        session_id = session.id
        findings["usage_at_create"] = usage_of(client, session_id)

        # Turn 1: two model requests (tool call, then reply), sleep so we can
        # observe usage while the turn is still running.
        findings["turn1_samples"] = run_turn(
            client, session_id,
            "Use bash exactly once and run: sleep 12; echo done. Then reply with one word.",
            180,
        )
        spans1 = span_usages(client, session_id)
        findings["turn1_spans"] = spans1
        findings["turn1_span_sum"] = span_sum(spans1)
        findings["turn1_session_usage"] = usage_of(client, session_id)

        # Turn 2: cumulative? cache read on the second turn?
        findings["turn2_samples"] = run_turn(client, session_id, "Reply with exactly: second", 120)
        spans2 = span_usages(client, session_id)
        findings["turn2_spans_all"] = spans2
        findings["turn2_span_sum_all"] = span_sum(spans2)
        findings["turn2_session_usage"] = usage_of(client, session_id)

        listed = [public(s) for s in client.beta.sessions.list(limit=20) if s.id == session_id]
        findings["list_item_usage"] = listed[0].get("usage") if listed else "NOT_FOUND"
        print(json.dumps(findings, indent=2, sort_keys=True, default=str))
    finally:
        if session_id:
            try:
                client.beta.sessions.delete(session_id)
            except Exception as exc:  # noqa: BLE001
                print(f"cleanup session: {exc}")
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
