#!/usr/bin/env python3
"""Probe 65 — hosted CMA glob edge-case behavior.

Run:
  uv run --with anthropic python scratch/65-managed-agents-glob-edge-probe.py

The artifact retains tool inputs/results and event shapes while removing durable
CMA IDs. The setup bash call creates a deterministic in-session corpus; all
subsequent filesystem observations are made through glob.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

import anthropic

API_KEY_ENV = Path("/Users/oner/dev/junk/cwc-workshops/.env")
MODEL = os.environ.get("OMA_GLOB_EDGE_PROBE_MODEL", "claude-sonnet-5")
RUN_ID = uuid.uuid4().hex[:8]
ARTIFACT = Path(__file__).parent / "artifacts" / "65-managed-agents-glob-edge-probe.json"
EXPECTED_GLOB_CALLS = 8

SETUP_COMMAND = """set -eu
root=/mnt/session/glob65
rm -rf "$root"
mkdir -p "$root/nested/deeper" "$root/node_modules/pkg"
printf 'alpha' > "$root/a.md"
printf 'zulu' > "$root/z.md"
printf 'hidden' > "$root/.hidden.md"
printf 'nested' > "$root/nested/b.md"
printf 'deep' > "$root/nested/deeper/c.md"
printf 'ignored' > "$root/ignored.md"
printf 'dependency' > "$root/node_modules/pkg/dependency.md"
printf 'ignored.md\n' > "$root/.gitignore"
i=1
while [ "$i" -le 150 ]; do printf x > "$root/many-$(printf '%03d' "$i").txt"; i=$((i+1)); done
"""


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
    if isinstance(value, str):
        for prefix in ("env_", "agent_", "sesn_", "sevt_", "sthr_"):
            if prefix in value:
                value = value.replace(prefix, f"{prefix}<redacted>")
        return value
    if isinstance(value, list):
        return [redact_ids(item) for item in value]
    if isinstance(value, dict):
        return {
            str(key): redact_ids(item)
            for key, item in value.items()
            if key not in {"id", "request_id", "tool_use_id"}
        }
    return value


def event_shape(event: Any) -> dict[str, Any]:
    shaped: dict[str, Any] = {"type": str(getattr(event, "type", ""))}
    for field in (
        "name", "input", "result", "content", "details", "is_error",
        "evaluated_permission", "stop_reason",
    ):
        value = getattr(event, field, None)
        if value is not None:
            shaped[field] = redact_ids(public(value))
    return shaped


def list_events(client: anthropic.Anthropic, session_id: str) -> list[dict[str, Any]]:
    return [event_shape(event) for event in client.beta.sessions.events.list(session_id, limit=500)]


def wait_for_terminal(client: anthropic.Anthropic, session_id: str, timeout_s: float = 300) -> list[dict[str, Any]]:
    deadline = time.monotonic() + timeout_s
    last: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        last = list_events(client, session_id)
        glob_count = sum(
            event.get("type") == "agent.tool_use" and event.get("name") == "glob"
            for event in last
        )
        terminal = any(event.get("type") in {"session.error", "session.status_idle"} for event in last)
        if glob_count >= EXPECTED_GLOB_CALLS and terminal:
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
    result: dict[str, Any] = {"run_id": RUN_ID, "model": MODEL}
    try:
        agent = client.beta.agents.create(
            name=f"oma-probe65-glob-edges-{RUN_ID}",
            model=MODEL,
            system=(
                "You are executing a deterministic tool probe. First call bash exactly once "
                "with the setup command supplied by the user. Then call glob exactly eight "
                "times, in the numbered order and with exactly the supplied JSON inputs—even "
                "when an input appears invalid. Do not call any other tool and do not repair, "
                "retry, or reinterpret an input. Finish with one short sentence."
            ),
            tools=[{
                "type": "agent_toolset_20260401",
                "default_config": {"enabled": False},
                "configs": [
                    {"name": "bash", "enabled": True, "permission_policy": {"type": "always_allow"}},
                    {"name": "glob", "enabled": True, "permission_policy": {"type": "always_allow"}},
                ],
            }],
        )
        agent_id = agent.id
        environment = client.beta.environments.create(
            name=f"oma-probe65-env-{RUN_ID}", config={"type": "cloud"}
        )
        environment_id = environment.id
        session = client.beta.sessions.create(
            agent=agent_id,
            environment_id=environment_id,
            title=f"OMA probe 65 {RUN_ID}",
        )
        session_id = session.id
        prompt = f"""Run this setup command in one bash call:\n\n{SETUP_COMMAND}\n\nThen make these glob calls exactly in order:\n1. {{"pattern":"*.md"}}\n2. {{"pattern":"*.nomatch","path":"/mnt/session/glob65"}}\n3. {{"pattern":"*.md","path":"/mnt/session/glob65/missing"}}\n4. {{"pattern":"**/*.md","path":"/mnt/session/glob65"}}\n5. {{"pattern":"*.md","path":"/mnt/session/glob65"}}\n6. {{"pattern":".*","path":"/mnt/session/glob65"}}\n7. {{"pattern":"many-*.txt","path":"/mnt/session/glob65"}}\n8. {{"pattern":"[","path":"/mnt/session/glob65"}}\n"""
        client.beta.sessions.events.send(
            session_id,
            events=[{"type": "user.message", "content": [{"type": "text", "text": prompt}]}],
        )
        result["events"] = wait_for_terminal(client, session_id)
        result["tool_uses"] = [
            {"name": event.get("name"), "input": event.get("input"), "evaluated_permission": event.get("evaluated_permission")}
            for event in result["events"]
            if event.get("type") == "agent.tool_use"
        ]
        result["glob_call_count"] = sum(item.get("name") == "glob" for item in result["tool_uses"])
    except Exception as exc:  # noqa: BLE001
        result["error"] = error_shape(exc)
    finally:
        if session_id:
            try:
                client.beta.sessions.delete(session_id)
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
