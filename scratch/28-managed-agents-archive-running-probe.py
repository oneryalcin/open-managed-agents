#!/usr/bin/env python3
"""Live probe: archive a hosted Managed Agents session while it is running.

Question this answers:
  Does Anthropic's hosted `sessions.archive()` reject a running session
  ("interrupt first"), or does it implicitly interrupt/archive?

Requires:
  ANTHROPIC_API_KEY

Optional:
  OMA_PROBE_ENVIRONMENT_ID
  OMA_ARCHIVE_PROBE_MODEL (default: claude-sonnet-4-6)

Run:
  uv run --with anthropic python scratch/28-managed-agents-archive-running-probe.py
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

import anthropic


MODEL = os.environ.get("OMA_ARCHIVE_PROBE_MODEL", "claude-sonnet-4-6")
RUN_ID = f"{int(time.time())}-{os.getpid()}"
MARKER = f"OMA_ARCHIVE_RUNNING_PROBE_{RUN_ID}"


def public(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [public(item) for item in value]
    if isinstance(value, dict):
        return {str(key): public(val) for key, val in value.items()}
    if hasattr(value, "model_dump"):
        return public(value.model_dump())
    if hasattr(value, "__dict__"):
        return public(
            {
                key: val
                for key, val in vars(value).items()
                if not key.startswith("_")
            }
        )
    return repr(value)


def emit(label: str, value: Any) -> None:
    print(f"## {label}")
    print(json.dumps(public(value), indent=2, sort_keys=True, default=str))


def error_shape(exc: BaseException) -> dict[str, Any]:
    return {
        "type": type(exc).__name__,
        "status_code": getattr(exc, "status_code", None),
        "message": str(exc)[:1000],
        "body": public(getattr(exc, "body", None)),
    }


def first_id(items: Any) -> str:
    for item in items:
        return item.id
    raise RuntimeError("no items available")


def event_type(event: Any) -> str:
    return str(getattr(event, "type", ""))


def main() -> None:
    client = anthropic.Anthropic()
    env_id = os.environ.get("OMA_PROBE_ENVIRONMENT_ID")
    agent_id: str | None = None
    session_id: str | None = None
    created_env_id: str | None = None
    archive_result: dict[str, Any] | None = None
    observed_events: list[dict[str, Any]] = []

    try:
        if env_id is None:
            try:
                env_id = first_id(client.beta.environments.list(limit=1))
                emit("environment.reused", {"id": env_id})
            except RuntimeError:
                env = client.beta.environments.create(
                    name=f"oma-archive-running-probe-{RUN_ID}",
                    config={"type": "cloud", "networking": {"type": "unrestricted"}},
                )
                env_id = env.id
                created_env_id = env.id
                emit("environment.created", env)

        agent = client.beta.agents.create(
            name=f"oma-archive-running-probe-{RUN_ID}",
            model=MODEL,
            system=(
                "When asked, use bash exactly once. Do not answer from memory. "
                "Use the provided exact command."
            ),
            tools=[
                {
                    "type": "agent_toolset_20260401",
                    "default_config": {
                        "enabled": True,
                        "permission_policy": {"type": "always_allow"},
                    },
                }
            ],
        )
        agent_id = agent.id
        emit("agent.created", {"id": agent_id, "model": MODEL})

        session = client.beta.sessions.create(
            agent=agent_id,
            environment_id=env_id,
            title=f"oma-archive-running-probe-{RUN_ID}",
        )
        session_id = session.id
        emit("session.created", session)

        archive_attempted = False
        send_response: Any = None
        deadline = time.monotonic() + 180
        with client.beta.sessions.events.stream(session_id) as stream:
            send_response = client.beta.sessions.events.send(
                session_id,
                events=[
                    {
                        "type": "user.message",
                        "content": [
                            {
                                "type": "text",
                                "text": (
                                    "Use the bash tool exactly once. "
                                    "Run this exact command: "
                                    f"sleep 20; printf '{MARKER}\\n'. "
                                    "Do not answer from memory."
                                ),
                            }
                        ],
                    }
                ],
            )
            emit("events.send", send_response)

            for event in stream:
                typ = event_type(event)
                observed_events.append(
                    {
                        "type": typ,
                        "name": getattr(event, "name", None),
                        "status": getattr(event, "status", None),
                    }
                )
                if not archive_attempted and typ in {
                    "session.status_running",
                    "agent.tool_use",
                }:
                    archive_attempted = True
                    try:
                        archived = client.beta.sessions.archive(session_id)
                        archive_result = {
                            "ok": True,
                            "response": public(archived),
                        }
                    except Exception as exc:  # noqa: BLE001
                        archive_result = {
                            "ok": False,
                            "error": error_shape(exc),
                        }
                    emit("sessions.archive.mid_run", archive_result)
                if archive_attempted and typ in {
                    "session.status_idle",
                    "session.status_terminated",
                    "session.error",
                }:
                    break
                if time.monotonic() > deadline:
                    raise TimeoutError("timed out waiting for terminal post-archive event")

        emit("stream.observed_events", observed_events)
        emit(
            "session.retrieve.after_archive_attempt",
            client.beta.sessions.retrieve(session_id),
        )
        emit(
            "events.list.after_archive_attempt",
            list(client.beta.sessions.events.list(session_id, limit=50)),
        )
        verdict = {
            "archive_attempted": archive_result is not None,
            "archive_accepted": bool(archive_result and archive_result["ok"]),
            "archive_status_code": None
            if archive_result is None or archive_result["ok"]
            else archive_result["error"].get("status_code"),
            "observed_event_types": [item["type"] for item in observed_events],
        }
        emit("verdict", verdict)
    finally:
        if session_id:
            try:
                emit("session.delete.cleanup", client.beta.sessions.delete(session_id))
            except Exception as exc:  # noqa: BLE001
                emit("session.delete.cleanup.error", error_shape(exc))
        if agent_id:
            try:
                archived_agent = client.beta.agents.archive(agent_id)
                emit(
                    "agent.archive.cleanup",
                    {
                        "id": archived_agent.id,
                        "archived_at": getattr(archived_agent, "archived_at", None),
                    },
                )
            except Exception as exc:  # noqa: BLE001
                emit("agent.archive.cleanup.error", error_shape(exc))
        if created_env_id:
            try:
                emit(
                    "environment.delete.cleanup",
                    client.beta.environments.delete(created_env_id),
                )
            except Exception as exc:  # noqa: BLE001
                emit("environment.delete.cleanup.error", error_shape(exc))


if __name__ == "__main__":
    main()
