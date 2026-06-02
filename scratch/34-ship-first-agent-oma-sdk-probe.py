#!/usr/bin/env python3
"""Probe #78-A: drive OMA with the real Python Anthropic SDK.

This adapts the `ship-your-first-managed-agent/e2e.py` tutorial flow to OMA.
The point is not to hide incompatibilities; it records the first concrete
client-contract break so #78 can become implementation slices.

Run with a local OMA server:

  OMA_PROBE_BASE_URL=http://127.0.0.1:40178 \
  uv run --with anthropic python scratch/34-ship-first-agent-oma-sdk-probe.py

Pair with:

  ANTHROPIC_API_KEY=... \
  OMA_SANDBOX_PROVIDER=docker-local \
  OMA_ALLOW_DOCKER_LOCAL=true \
  OMA_PROBE_PORT=40178 \
  npx tsx scratch/34-ship-first-agent-oma-server.ts
"""

from __future__ import annotations

import io
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import anthropic
import httpx


WORKSHOP_DIR = os.environ.get("OMA_SHIP_FIRST_WORKSHOP_DIR")
WORKSHOP = Path(WORKSHOP_DIR) if WORKSHOP_DIR else None
DATA = WORKSHOP / "data" if WORKSHOP else None
BASE_URL = os.environ.get("OMA_PROBE_BASE_URL", "http://127.0.0.1:40178")
BETA = os.environ.get("OMA_MANAGED_AGENTS_BETA", "managed-agents-2026-04-01")
MODEL = os.environ.get("OMA_SHIP_FIRST_PROBE_MODEL", "claude-sonnet-4-6")
LOG_HTTP = os.environ.get("OMA_PROBE_LOG_HTTP") == "true"

SYSTEM = (
    "You are the SRE Agent, an SRE/data-analyst agent. Analyze "
    "/mnt/session/uploads/app.log (large; use grep/python), pull metrics and "
    "deploys via your tools, inspect suspicious diffs, and state the root cause "
    "plainly."
)
TOOLS = [
    {
        "type": "agent_toolset_20260401",
        "default_config": {
            "enabled": True,
            "permission_policy": {"type": "always_allow"},
        },
    },
    {
        "type": "custom",
        "name": "get_metrics",
        "description": "Timeseries for service+metric.",
        "input_schema": {
            "type": "object",
            "properties": {
                "service": {"type": "string"},
                "metric": {"type": "string"},
            },
            "required": ["service", "metric"],
        },
    },
    {
        "type": "custom",
        "name": "get_recent_deploys",
        "description": "Deploys last 6h.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "type": "custom",
        "name": "get_diff",
        "description": "Diff for a commit.",
        "input_schema": {
            "type": "object",
            "properties": {"commit": {"type": "string"}},
            "required": ["commit"],
        },
    },
]


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


def log_request(request: httpx.Request) -> None:
    if not LOG_HTTP:
        return
    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() in {"anthropic-beta", "content-type", "x-api-key"}
    }
    if "x-api-key" in headers:
        headers["x-api-key"] = "<redacted>"
    emit("http.request", {"method": request.method, "url": str(request.url), "headers": headers})


def load_text(name: str) -> str:
    if DATA is None:
        raise RuntimeError("OMA_SHIP_FIRST_WORKSHOP_DIR must point to the workshop checkout")
    return (DATA / name).read_text()


metrics: dict[str, Any] = {}
deploys = ""
diff = ""


def handle_tool(name: str, args: dict[str, Any]) -> str:
    if name == "get_metrics":
        return json.dumps(
            metrics.get(args.get("service"), {}).get(args.get("metric"))
            or {"error": "not found"}
        )
    if name == "get_recent_deploys":
        return deploys
    if name == "get_diff":
        commit = str(args.get("commit", ""))
        return diff if commit[:7] in diff else "no diff"
    return f"unknown tool {name}"


def text_from_blocks(blocks: Any) -> str:
    out: list[str] = []
    for block in blocks or []:
        if getattr(block, "type", None) == "text":
            out.append(getattr(block, "text", ""))
    return "".join(out)


def main() -> int:
    global metrics, deploys, diff

    if WORKSHOP is None:
        emit(
            "probe.config_error",
            {"message": "OMA_SHIP_FIRST_WORKSHOP_DIR must point to the workshop checkout"},
        )
        return 2
    if DATA is None or not DATA.exists():
        emit(
            "probe.config_error",
            {"message": f"workshop data directory not found: {DATA}"},
        )
        return 2
    metrics = json.loads(load_text("metrics.json"))
    deploys = load_text("deploys.json")
    diff = load_text("diff.txt")

    http_client = httpx.Client(event_hooks={"request": [log_request]})
    client = anthropic.Anthropic(
        api_key=os.environ.get("ANTHROPIC_API_KEY", "oma-local-dummy-key"),
        base_url=BASE_URL,
        default_headers={"anthropic-beta": BETA},
        http_client=http_client,
        max_retries=0,
        timeout=120,
    )

    created: dict[str, str] = {}
    events_seen: list[str] = []
    transcript: list[str] = []
    custom_tool_calls: list[str] = []
    builtin_tool_calls: list[str] = []

    try:
        emit("probe.config", {"base_url": BASE_URL, "beta": BETA, "model": MODEL})

        agent = client.beta.agents.create(
            name=f"oma-ship-first-probe-{int(time.time())}",
            model=MODEL,
            system=SYSTEM,
            tools=TOOLS,
        )
        created["agent_id"] = agent.id
        emit("agent.created", {"id": agent.id})

        environment = client.beta.environments.create(
            name=f"oma-ship-first-probe-{int(time.time())}",
            config={"type": "cloud", "networking": {"type": "unrestricted"}},
        )
        created["environment_id"] = environment.id
        emit("environment.created", {"id": environment.id})

        with open(DATA / "app.log", "rb") as file:
            uploaded = client.beta.files.upload(
                file=("app.log", io.BytesIO(file.read()), "text/plain")
            )
        created["file_id"] = uploaded.id
        emit("file.uploaded", {"id": uploaded.id})

        session = client.beta.sessions.create(
            agent=agent.id,
            environment_id=environment.id,
            title="ship-your-first-managed-agent parity probe",
            resources=[
                {"type": "file", "file_id": uploaded.id, "mount_path": "app.log"}
            ],
        )
        created["session_id"] = session.id
        emit(
            "session.created",
            {"id": session.id, "resources": getattr(session, "resources", None)},
        )

        deadline = time.monotonic() + 300
        with client.beta.sessions.events.stream(session.id) as stream:
            client.beta.sessions.events.send(
                session.id,
                events=[
                    {
                        "type": "user.message",
                        "content": [
                            {
                                "type": "text",
                                "text": (
                                    "checkout p99 spiked around 14:32 UTC. "
                                    "Use bash on /mnt/session/uploads/app.log "
                                    "and your tools to find the root cause."
                                ),
                            }
                        ],
                    }
                ],
            )
            for event in stream:
                event_type = str(getattr(event, "type", ""))
                events_seen.append(event_type)
                if event_type == "agent.message":
                    transcript.append(text_from_blocks(getattr(event, "content", [])))
                elif event_type == "agent.tool_use":
                    builtin_tool_calls.append(str(getattr(event, "name", "")))
                elif event_type == "agent.custom_tool_use":
                    custom_tool_calls.append(str(getattr(event, "name", "")))
                    result = handle_tool(
                        str(getattr(event, "name", "")),
                        public(getattr(event, "input", {})),
                    )
                    client.beta.sessions.events.send(
                        session.id,
                        events=[
                            {
                                "type": "user.custom_tool_result",
                                "custom_tool_use_id": event.id,
                                "content": [{"type": "text", "text": result}],
                            }
                        ],
                    )
                elif event_type == "session.status_idle":
                    stop_reason = getattr(event, "stop_reason", None)
                    if getattr(stop_reason, "type", None) == "end_turn":
                        break
                if time.monotonic() > deadline:
                    raise TimeoutError("timed out waiting for end_turn")

        listed = client.beta.sessions.events.list(session.id, order="asc", limit=500)
        replay_types = [str(getattr(event, "type", "")) for event in listed.data]
        full = "".join(transcript).lower()
        verdict = {
            "events_seen": events_seen,
            "replay_types": replay_types,
            "builtin_tool_calls": builtin_tool_calls,
            "custom_tool_calls": custom_tool_calls,
            "mentions_bad_commit": "a3f9c21" in full,
            "mentions_n_plus_one": "n+1" in full or "n + 1" in full,
            "assistant_text_preview": "".join(transcript)[-1000:],
        }
        verdict["pass"] = (
            bool(builtin_tool_calls)
            and verdict["mentions_bad_commit"]
            and verdict["mentions_n_plus_one"]
        )
        emit("verdict", verdict)
        return 0 if verdict["pass"] else 1
    except Exception as exc:  # noqa: BLE001
        emit(
            "probe.error",
            {
                "type": type(exc).__name__,
                "message": str(exc),
                "created": created,
                "events_seen": events_seen,
            },
        )
        return 2
    finally:
        session_id = created.get("session_id")
        if session_id:
            try:
                emit("session.deleted", client.beta.sessions.delete(session_id))
            except Exception as exc:  # noqa: BLE001
                emit("session.delete.error", {"type": type(exc).__name__, "message": str(exc)})
        file_id = created.get("file_id")
        if file_id:
            try:
                emit("file.deleted", client.beta.files.delete(file_id))
            except Exception as exc:  # noqa: BLE001
                emit("file.delete.error", {"type": type(exc).__name__, "message": str(exc)})


if __name__ == "__main__":
    sys.exit(main())
