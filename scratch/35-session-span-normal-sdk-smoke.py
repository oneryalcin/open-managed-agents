#!/usr/bin/env python3
# Smoke 35 — live Python SDK check for normal model-request spans.
#
# Prerequisites:
#   1. Start the local example server from the repo root:
#      OMA_SANDBOX_PROVIDER=docker-local \
#      OMA_ALLOW_DOCKER_LOCAL=true \
#      OMA_PROBE_PORT=40179 \
#      npx tsx examples/ship-your-first-managed-agent/oma-server.ts
#
#   2. Run from the repo root:
#      OMA_PROBE_BASE_URL=http://127.0.0.1:40179 \
#      OMA_EXAMPLE_DIR=examples/ship-your-first-managed-agent \
#      uv run --with-requirements examples/ship-your-first-managed-agent/requirements.txt \
#        python scratch/35-session-span-normal-sdk-smoke.py

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

import anthropic
from dotenv import load_dotenv

example_dir = Path(os.environ.get("OMA_EXAMPLE_DIR", "examples/ship-your-first-managed-agent"))
load_dotenv(example_dir / ".env")

base_url = os.environ.get("OMA_PROBE_BASE_URL", "http://127.0.0.1:40179")
beta = os.environ.get("OMA_MANAGED_AGENTS_BETA", "managed-agents-2026-04-01")
model = os.environ.get("OMA_SHIP_FIRST_PROBE_MODEL", "claude-sonnet-4-6")

client = anthropic.Anthropic(
    api_key=os.environ.get("ANTHROPIC_API_KEY", "oma-local-dummy-key"),
    base_url=base_url,
    default_headers={"anthropic-beta": beta},
    max_retries=0,
    timeout=120,
)

created: dict[str, str] = {}


def public(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [public(item) for item in value]
    if isinstance(value, dict):
        return {str(k): public(v) for k, v in value.items()}
    if hasattr(value, "model_dump"):
        return public(value.model_dump())
    return repr(value)


def emit(label: str, value: Any) -> None:
    print(f"## {label}")
    print(json.dumps(public(value), indent=2, sort_keys=True, default=str))


try:
    agent = client.beta.agents.create(
        name=f"OMA normal span smoke {uuid.uuid4().hex[:6]}",
        model=model,
        system="Reply concisely.",
        tools=[],
    )
    created["agent_id"] = agent.id
    env = client.beta.environments.create(
        name=f"oma-normal-span-{uuid.uuid4().hex[:6]}",
        config={"type": "cloud", "networking": {"type": "unrestricted"}},
    )
    created["environment_id"] = env.id
    session = client.beta.sessions.create(agent=agent.id, environment_id=env.id)
    created["session_id"] = session.id

    seen: list[str] = []
    with client.beta.sessions.events.stream(session.id) as stream:
        client.beta.sessions.events.send(
            session.id,
            events=[
                {
                    "type": "user.message",
                    "content": [
                        {
                            "type": "text",
                            "text": "Reply with exactly: OMA normal span smoke OK",
                        }
                    ],
                }
            ],
        )
        deadline = time.monotonic() + 120
        for event in stream:
            seen.append(str(event.type))
            if event.type == "session.status_idle" and event.stop_reason.type == "end_turn":
                break
            if time.monotonic() > deadline:
                raise TimeoutError("timed out waiting for idle")

    listed = client.beta.sessions.events.list(session.id, order="asc", limit=200)
    replay_types = [str(event.type) for event in listed.data]
    starts = [event for event in listed.data if event.type == "span.model_request_start"]
    ends = [event for event in listed.data if event.type == "span.model_request_end"]
    messages = [event for event in listed.data if event.type == "agent.message"]
    span_ok = (
        len(starts) == 1
        and len(ends) == 1
        and getattr(ends[0], "model_request_start_id", None) == starts[0].id
        and getattr(ends[0], "is_error", None) is False
        and bool(messages)
    )
    emit(
        "normal.verdict",
        {
            "pass": span_ok,
            "seen": seen,
            "replay_types": replay_types,
            "span_start_id": starts[0].id if starts else None,
            "span_end_start_id": getattr(ends[0], "model_request_start_id", None)
            if ends
            else None,
            "span_end_is_error": getattr(ends[0], "is_error", None) if ends else None,
        },
    )
    raise SystemExit(0 if span_ok else 1)
finally:
    session_id = created.get("session_id")
    if session_id:
        try:
            emit("session.deleted", client.beta.sessions.delete(session_id))
        except Exception as exc:  # noqa: BLE001
            emit("session.delete.error", {"type": type(exc).__name__, "message": str(exc)})
