#!/usr/bin/env python3
"""Probe 68c -- hosted CMA grep nested and missing path behavior.

Run:
  uv run --with anthropic python scratch/68c-managed-agents-grep-path-errors-probe.py
"""

from __future__ import annotations

import io
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

import anthropic


API_KEY_ENV = Path("/Users/oner/dev/junk/cwc-workshops/.env")
MODEL = os.environ.get("OMA_GREP_PROBE_MODEL", "claude-sonnet-5")
RUN_ID = uuid.uuid4().hex[:8]
ARTIFACT = Path(__file__).parent / "artifacts" / "68c-managed-agents-grep-path-errors-probe.json"
ID_MAP: dict[str, str] = {}


def load_probe_key() -> str:
    for line in API_KEY_ENV.read_text().splitlines():
        if line.strip().startswith("ANTHROPIC_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit(f"ANTHROPIC_API_KEY not found in {API_KEY_ENV}")


def public(value: Any, key: str | None = None) -> Any:
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        if key in {"id", "tool_use_id"}:
            ID_MAP.setdefault(value, f"id_{len(ID_MAP) + 1:03d}")
            return ID_MAP[value]
        if re.fullmatch(r"(?:agent|env|sesn|file|sevt|sthr)_[0-9A-Za-z_-]+", value):
            ID_MAP.setdefault(value, f"id_{len(ID_MAP) + 1:03d}")
            return ID_MAP[value]
        for prefix in ("agent_", "env_", "sesn_", "file_", "sevt_", "sthr_"):
            value = value.replace(prefix, f"{prefix}<redacted>")
        return value
    if isinstance(value, list):
        return [public(item) for item in value]
    if isinstance(value, dict):
        return {str(k): public(v, str(k)) for k, v in value.items() if str(k) != "request_id"}
    return repr(value)


def shape(event: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"type": str(getattr(event, "type", ""))}
    for field in ("id", "tool_use_id", "name", "input", "content", "is_error", "evaluated_permission", "stop_reason"):
        value = getattr(event, field, None)
        if value is not None:
            out[field] = public(value, field)
    return out


def events(client: anthropic.Anthropic, session_id: str) -> list[dict[str, Any]]:
    return [shape(event) for event in client.beta.sessions.events.list(session_id, limit=200)]


def wait(client: anthropic.Anthropic, session_id: str, calls: int) -> list[dict[str, Any]]:
    deadline = time.monotonic() + 180
    last: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        last = events(client, session_id)
        uses = [e for e in last if e.get("type") == "agent.tool_use" and e.get("name") == "grep"]
        results = [e for e in last if e.get("type") == "agent.tool_result"]
        terminal = [e for e in last if e.get("type") in {"session.error", "session.status_idle"}]
        if len(uses) >= calls and len(results) >= calls and terminal:
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
    environment_id: str | None = None
    session_id: str | None = None
    file_ids: list[str] = []
    result: dict[str, Any] = {"run_id": RUN_ID, "model": MODEL, "expected_grep_calls": 2}
    cases = [
        {
            "case": "absolute_nested_path",
            "input": {
                "pattern": "NESTED68C",
                "path": "/mnt/session/uploads/nested",
                "glob": "*.md",
                "context": 0,
                "head_limit": 5,
            },
        },
        {
            "case": "missing_path",
            "input": {
                "pattern": "NESTED68C",
                "path": "/mnt/session/uploads/missing",
                "context": 0,
                "head_limit": 5,
            },
        },
    ]
    result["cases"] = cases
    try:
        agent = client.beta.agents.create(
            name=f"oma-probe68c-grep-{RUN_ID}",
            model=MODEL,
            system=(
                "You are running a grep path error probe. Call grep exactly "
                "twice, in the listed order, using the JSON inputs exactly. "
                "Do not call any other tools."
            ),
            tools=[{
                "type": "agent_toolset_20260401",
                "default_config": {"enabled": True, "permission_policy": {"type": "always_allow"}},
                "configs": [{"name": "grep", "enabled": True, "permission_policy": {"type": "always_allow"}}],
            }],
        )
        agent_id = agent.id
        environment = client.beta.environments.create(name=f"oma-probe68c-env-{RUN_ID}", config={"type": "cloud"})
        environment_id = environment.id
        uploaded = client.beta.files.upload(
            file=("nested.md", io.BytesIO(b"NESTED68C nested\n"), "text/markdown"),
        )
        file_ids.append(uploaded.id)
        session = client.beta.sessions.create(
            agent=agent_id,
            environment_id=environment_id,
            title=f"OMA grep probe 68c {RUN_ID}",
            resources=[{"type": "file", "file_id": uploaded.id, "mount_path": "nested/nested.md"}],
        )
        session_id = session.id
        text = "\n".join(
            f"{i}. case={case['case']} input={json.dumps(case['input'], sort_keys=True)}"
            for i, case in enumerate(cases, start=1)
        )
        client.beta.sessions.events.send(
            session_id,
            events=[{"type": "user.message", "content": [{"type": "text", "text": text}]}],
        )
        result["events"] = wait(client, session_id, len(cases))
        result["tool_uses"] = [
            {"id": e.get("id"), "name": e.get("name"), "input": e.get("input"), "evaluated_permission": e.get("evaluated_permission")}
            for e in result["events"]
            if e.get("type") == "agent.tool_use"
        ]
        result["tool_results"] = [
            {"tool_use_id": e.get("tool_use_id"), "is_error": e.get("is_error"), "content": e.get("content")}
            for e in result["events"]
            if e.get("type") == "agent.tool_result"
        ]
    except Exception as exc:  # noqa: BLE001
        result["error"] = error_shape(exc)
    finally:
        if session_id:
            try:
                client.beta.sessions.events.send(
                    session_id,
                    events=[{"type": "user.interrupt"}],
                )
            except Exception:
                pass
            cleanup_deadline = time.monotonic() + 60
            while time.monotonic() < cleanup_deadline:
                try:
                    status = client.beta.sessions.retrieve(session_id).status
                    if status != "running":
                        break
                except Exception:
                    break
                time.sleep(2)
            try:
                client.beta.sessions.delete(session_id)
            except Exception:
                pass
        for file_id in reversed(file_ids):
            try:
                client.beta.files.delete(file_id)
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
    redacted = public(result)
    ARTIFACT.write_text(json.dumps(redacted, indent=2, sort_keys=True))
    print(json.dumps(redacted, indent=2, sort_keys=True))
    print(f"\nwrote {ARTIFACT}")


if __name__ == "__main__":
    main()
