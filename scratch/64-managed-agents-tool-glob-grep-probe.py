#!/usr/bin/env python3
"""Probe 64 — hosted glob/grep tool input and output shapes.

Run:
  uv run --with anthropic python scratch/64-managed-agents-tool-glob-grep-probe.py

The agent is instructed to call glob and grep exactly once each. The artifact
records redacted event types, tool names, inputs, and result content/details;
organization-scoped IDs are not written.
"""

from __future__ import annotations

import io
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

import anthropic


API_KEY_ENV = Path("/Users/oner/dev/junk/cwc-workshops/.env")
MODEL = os.environ.get("OMA_GLOB_GREP_PROBE_MODEL", "claude-sonnet-5")
RUN_ID = uuid.uuid4().hex[:8]
ARTIFACT = Path(__file__).parent / "artifacts" / "64-managed-agents-tool-glob-grep-probe.json"


def load_probe_key() -> str:
    for line in API_KEY_ENV.read_text().splitlines():
        if line.strip().startswith("ANTHROPIC_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit(f"ANTHROPIC_API_KEY not found in {API_KEY_ENV}")


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


def redact_ids(value: Any) -> Any:
    # Tool results may contain paths but should not contain durable CMA IDs;
    # keep the generic redaction narrow so input/output shapes remain visible.
    if isinstance(value, str):
        for prefix in ("env_", "agent_", "sesn_", "sevt_", "sthr_"):
            if prefix in value:
                value = value.replace(prefix, f"{prefix}<redacted>")
        return value
    if isinstance(value, list):
        return [redact_ids(item) for item in value]
    if isinstance(value, dict):
        return {str(key): redact_ids(item) for key, item in value.items() if key not in {"id", "request_id", "tool_use_id"}}
    return value


def event_shape(event: Any) -> dict[str, Any]:
    event_type = str(getattr(event, "type", ""))
    result: dict[str, Any] = {"type": event_type}
    for field in ("name", "input", "result", "content", "details", "is_error", "evaluated_permission", "stop_reason"):
        value = getattr(event, field, None)
        if value is not None:
            result[field] = redact_ids(public(value))
    return result


def list_events(client: anthropic.Anthropic, session_id: str) -> list[dict[str, Any]]:
    return [event_shape(event) for event in client.beta.sessions.events.list(session_id, limit=200)]


def wait_for_terminal(
    client: anthropic.Anthropic,
    session_id: str,
    timeout_s: float = 240,
) -> list[dict[str, Any]]:
    deadline = time.monotonic() + timeout_s
    last: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        last = list_events(client, session_id)
        names = {event.get("name") for event in last if event.get("type") == "agent.tool_use"}
        terminal = [event for event in last if event.get("type") in {"session.error", "session.status_idle"}]
        if {"glob", "grep"}.issubset(names) and terminal:
            return last
        time.sleep(2)
    return last


def error_shape(exc: BaseException) -> dict[str, Any]:
    body = getattr(exc, "body", None)
    error = body.get("error") if isinstance(body, dict) else None
    return {
        "status_code": getattr(exc, "status_code", None),
        "error_type": error.get("type") if isinstance(error, dict) else None,
        "message": error.get("message") if isinstance(error, dict) else str(exc)[:500],
    }


def main() -> None:
    client = anthropic.Anthropic(api_key=load_probe_key())
    agent_id: str | None = None
    session_id: str | None = None
    environment_id: str | None = None
    uploaded_file_id: str | None = None
    result: dict[str, Any] = {"run_id": RUN_ID, "model": MODEL}
    try:
        agent = client.beta.agents.create(
            name=f"oma-probe64-glob-grep-{RUN_ID}",
            model=MODEL,
            system=(
                "You are running a tool-shape probe. You MUST call glob exactly once "
                "and grep exactly once, in that order, then give a one-sentence summary. "
                "Do not use bash, read, write, edit, web_fetch, or web_search. "
                "For glob use pattern '*.md' and path '/mnt/session/uploads'. "
                "For grep use pattern 'probe' with path '/mnt/session/uploads', glob '*.md', "
                "literal true, context 1, and limit 5."
            ),
            tools=[{
                "type": "agent_toolset_20260401",
                "default_config": {"enabled": True, "permission_policy": {"type": "always_allow"}},
                "configs": [
                    {"name": "glob", "enabled": True, "permission_policy": {"type": "always_allow"}},
                    {"name": "grep", "enabled": True, "permission_policy": {"type": "always_allow"}},
                ],
            }],
        )
        agent_id = agent.id
        environment = client.beta.environments.create(
            name=f"oma-probe64-env-{RUN_ID}",
            config={"type": "cloud"},
        )
        environment_id = environment.id
        uploaded = client.beta.files.upload(
            file=("probe64.md", io.BytesIO(b"probe-64-line\nsecond line\n"), "text/markdown"),
        )
        uploaded_file_id = uploaded.id
        session = client.beta.sessions.create(
            agent=agent_id,
            environment_id=environment_id,
            title=f"OMA probe 64 {RUN_ID}",
            resources=[{
                "type": "file",
                "file_id": uploaded_file_id,
                "mount_path": "probe64.md",
            }],
        )
        session_id = session.id
        client.beta.sessions.events.send(
            session_id,
            events=[{
                "type": "user.message",
                "content": [{"type": "text", "text": "Run the required glob and grep probe now."}],
            }],
        )
        result["events"] = wait_for_terminal(client, session_id)
        result["tool_uses"] = [
            {"name": event.get("name"), "input": event.get("input"), "evaluated_permission": event.get("evaluated_permission")}
            for event in result["events"]
            if event.get("type") == "agent.tool_use"
        ]
    except Exception as exc:  # noqa: BLE001
        result["error"] = error_shape(exc)
    finally:
        if session_id:
            try:
                client.beta.sessions.delete(session_id)
            except Exception:
                pass
        if uploaded_file_id:
            try:
                client.beta.files.delete(uploaded_file_id)
            except Exception:
                pass
        if agent_id:
            try:
                client.beta.agents.archive(agent_id)
            except Exception:
                pass
        if environment_id:
            try:
                client.beta.environments.delete(environment_id)
            except Exception:
                try:
                    client.beta.environments.archive(environment_id)
                except Exception:
                    pass
    ARTIFACT.parent.mkdir(exist_ok=True)
    ARTIFACT.write_text(json.dumps(result, indent=2, sort_keys=True))
    print(json.dumps(result, indent=2, sort_keys=True))
    print(f"\nwrote {ARTIFACT}")


if __name__ == "__main__":
    main()
