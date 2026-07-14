#!/usr/bin/env python3
"""Probe 68 -- hosted CMA grep edge behavior.

Run:
  uv run --with anthropic python scratch/68-managed-agents-grep-edge-probe.py

Reads ANTHROPIC_API_KEY directly from the workshop .env. Durable hosted IDs are
redacted or pseudonymized in the artifact.
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
ARTIFACT = Path(__file__).parent / "artifacts" / "68-managed-agents-grep-edge-probe.json"

ID_MAP: dict[str, str] = {}


def load_probe_key() -> str:
    for line in API_KEY_ENV.read_text().splitlines():
        if line.strip().startswith("ANTHROPIC_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit(f"ANTHROPIC_API_KEY not found in {API_KEY_ENV}")


def alias_id(value: str, prefix: str) -> str:
    if value not in ID_MAP:
        ID_MAP[value] = f"{prefix}_{len(ID_MAP) + 1:03d}"
    return ID_MAP[value]


def public(value: Any, key: str | None = None) -> Any:
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        if key in {"id", "tool_use_id", "request_id"}:
            return alias_id(value, key.replace("_id", ""))
        if re.fullmatch(r"(?:agent|env|sesn|file|sevt|sthr)_[0-9A-Za-z_-]+", value):
            return alias_id(value, "id")
        for hosted_prefix in ("agent_", "env_", "sesn_", "file_", "sevt_", "sthr_"):
            value = value.replace(hosted_prefix, f"{hosted_prefix}<redacted>")
        return value
    if isinstance(value, list):
        return [public(item) for item in value]
    if isinstance(value, dict):
        return {
            str(k): public(v, str(k))
            for k, v in value.items()
            if str(k) not in {"request_id"}
        }
    return repr(value)


def event_shape(event: Any) -> dict[str, Any]:
    event_type = str(getattr(event, "type", ""))
    result: dict[str, Any] = {"type": event_type}
    for field in (
        "id",
        "tool_use_id",
        "name",
        "input",
        "result",
        "content",
        "details",
        "is_error",
        "evaluated_permission",
        "stop_reason",
    ):
        value = getattr(event, field, None)
        if value is not None:
            result[field] = public(value, field)
    return result


def list_events(client: anthropic.Anthropic, session_id: str) -> list[dict[str, Any]]:
    return [event_shape(event) for event in client.beta.sessions.events.list(session_id, limit=300)]


def wait_for_terminal(
    client: anthropic.Anthropic,
    session_id: str,
    expected_grep_calls: int,
    timeout_s: float = 300,
) -> list[dict[str, Any]]:
    deadline = time.monotonic() + timeout_s
    last: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        last = list_events(client, session_id)
        grep_uses = [
            event for event in last
            if event.get("type") == "agent.tool_use" and event.get("name") == "grep"
        ]
        grep_results = [
            event for event in last
            if event.get("type") == "agent.tool_result"
        ]
        terminal = [
            event for event in last
            if event.get("type") in {"session.error", "session.status_idle"}
        ]
        if len(grep_uses) >= expected_grep_calls and len(grep_results) >= expected_grep_calls and terminal:
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


def corpus_files() -> list[tuple[str, bytes, str]]:
    return [
        (
            "context.md",
            b"ctx-before\nCTX68 target one\nctx-middle\nCTX68 target two\nctx-after\n",
            "text/markdown",
        ),
        (
            "many.txt",
            b"LIMIT68 one\nLIMIT68 two\nLIMIT68 three\nLIMIT68 four\n",
            "text/plain",
        ),
        (
            "filter.md",
            b"FILTER68 markdown\n",
            "text/markdown",
        ),
        (
            "filter.txt",
            b"FILTER68 text\n",
            "text/plain",
        ),
        (
            "nomatch.md",
            b"this file intentionally lacks the absent token\n",
            "text/markdown",
        ),
        (
            "binary.bin",
            b"\x00BINARY68\x00probe\x00\n",
            "application/octet-stream",
        ),
        (
            "relative/rel.md",
            b"REL68 relative path\n",
            "text/markdown",
        ),
    ]


def main() -> None:
    client = anthropic.Anthropic(api_key=load_probe_key())
    agent_id: str | None = None
    session_id: str | None = None
    environment_id: str | None = None
    uploaded_file_ids: list[str] = []
    result: dict[str, Any] = {
        "run_id": RUN_ID,
        "model": MODEL,
        "expected_grep_calls": 7,
    }
    try:
        cases = [
            {
                "case": "no_match",
                "input": {
                    "pattern": "ABSENT68",
                    "path": "/mnt/session/uploads",
                    "glob": "*.md",
                    "context": 0,
                    "head_limit": 5,
                },
            },
            {
                "case": "context",
                "input": {
                    "pattern": "CTX68",
                    "path": "/mnt/session/uploads",
                    "glob": "context.md",
                    "context": 1,
                    "head_limit": 5,
                },
            },
            {
                "case": "head_limit",
                "input": {
                    "pattern": "LIMIT68",
                    "path": "/mnt/session/uploads",
                    "glob": "many.txt",
                    "context": 0,
                    "head_limit": 2,
                },
            },
            {
                "case": "glob_filter",
                "input": {
                    "pattern": "FILTER68",
                    "path": "/mnt/session/uploads",
                    "glob": "*.md",
                    "context": 0,
                    "head_limit": 5,
                },
            },
            {
                "case": "invalid_regex",
                "input": {
                    "pattern": "[",
                    "path": "/mnt/session/uploads",
                    "glob": "*.md",
                    "context": 0,
                    "head_limit": 5,
                },
            },
            {
                "case": "binaryish",
                "input": {
                    "pattern": "BINARY68",
                    "path": "/mnt/session/uploads",
                    "glob": "*.bin",
                    "context": 0,
                    "head_limit": 5,
                },
            },
            {
                "case": "relative_path",
                "input": {
                    "pattern": "REL68",
                    "path": "relative",
                    "glob": "*.md",
                    "context": 0,
                    "head_limit": 5,
                },
            },
        ]
        result["cases"] = cases
        agent = client.beta.agents.create(
            name=f"oma-probe68-grep-{RUN_ID}",
            model=MODEL,
            system=(
                "You are running a grep edge probe. You MUST call the grep tool "
                "exactly seven times, in the order listed by the user, using each "
                "JSON input exactly. Do not use bash, glob, read, write, edit, "
                "web_fetch, or web_search. After all grep calls finish, provide a "
                "short numbered summary."
            ),
            tools=[{
                "type": "agent_toolset_20260401",
                "default_config": {
                    "enabled": True,
                    "permission_policy": {"type": "always_allow"},
                },
                "configs": [
                    {"name": "grep", "enabled": True, "permission_policy": {"type": "always_allow"}},
                ],
            }],
        )
        agent_id = agent.id
        environment = client.beta.environments.create(
            name=f"oma-probe68-env-{RUN_ID}",
            config={"type": "cloud"},
        )
        environment_id = environment.id
        resources = []
        for mount_path, content, mime_type in corpus_files():
            uploaded = client.beta.files.upload(
                file=(Path(mount_path).name, io.BytesIO(content), mime_type),
            )
            uploaded_file_ids.append(uploaded.id)
            resources.append({
                "type": "file",
                "file_id": uploaded.id,
                "mount_path": mount_path,
            })
        session = client.beta.sessions.create(
            agent=agent_id,
            environment_id=environment_id,
            title=f"OMA grep probe 68 {RUN_ID}",
            resources=resources,
        )
        session_id = session.id
        instructions = "\n".join(
            f"{index}. case={case['case']} input={json.dumps(case['input'], sort_keys=True)}"
            for index, case in enumerate(cases, start=1)
        )
        client.beta.sessions.events.send(
            session_id,
            events=[{
                "type": "user.message",
                "content": [{
                    "type": "text",
                    "text": f"Run these grep calls exactly in order:\n{instructions}",
                }],
            }],
        )
        events = wait_for_terminal(client, session_id, expected_grep_calls=len(cases))
        result["events"] = events
        result["tool_uses"] = [
            {
                "id": event.get("id"),
                "name": event.get("name"),
                "input": event.get("input"),
                "evaluated_permission": event.get("evaluated_permission"),
            }
            for event in events
            if event.get("type") == "agent.tool_use"
        ]
        result["tool_results"] = [
            {
                "tool_use_id": event.get("tool_use_id"),
                "is_error": event.get("is_error"),
                "content": event.get("content"),
            }
            for event in events
            if event.get("type") == "agent.tool_result"
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
        for file_id in reversed(uploaded_file_ids):
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
