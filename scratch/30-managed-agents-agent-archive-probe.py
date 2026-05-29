#!/usr/bin/env python3
"""Live probe: Anthropic Managed Agents `agents.archive` behavior.

Questions this answers for OMA #39:
  - response shape and idempotency
  - retrieve/list behavior after archive
  - whether archived agents can create new sessions
  - whether existing/running sessions block or survive agent archive
  - whether archive applies to the whole agent line across versions
  - missing-agent error shape

Requires:
  ANTHROPIC_API_KEY

Optional:
  OMA_PROBE_ENVIRONMENT_ID (otherwise the probe creates and deletes a throwaway)
  OMA_ARCHIVE_PROBE_MODEL (default: claude-sonnet-4-6)

Run:
  uv run --with anthropic python scratch/30-managed-agents-agent-archive-probe.py
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any

import anthropic


MODEL = os.environ.get("OMA_ARCHIVE_PROBE_MODEL", "claude-sonnet-4-6")
RUN_ID = f"{int(time.time())}-{os.getpid()}"
MARKER = f"OMA_AGENT_ARCHIVE_PROBE_{RUN_ID}"
REQUEST_ID_RE = re.compile(r"req_[A-Za-z0-9]+")


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


def redact_request_ids(value: Any) -> Any:
    if isinstance(value, str):
        return REQUEST_ID_RE.sub("<redacted_request_id>", value)
    if isinstance(value, list):
        return [redact_request_ids(item) for item in value]
    if isinstance(value, dict):
        return {
            str(key): "<redacted_request_id>"
            if key == "request_id"
            else redact_request_ids(val)
            for key, val in value.items()
        }
    return value


def error_shape(exc: BaseException) -> dict[str, Any]:
    return {
        "type": type(exc).__name__,
        "status_code": getattr(exc, "status_code", None),
        "message": redact_request_ids(str(exc)[:1000]),
        "body": redact_request_ids(public(getattr(exc, "body", None))),
    }


def event_type(event: Any) -> str:
    return str(getattr(event, "type", ""))


def call(label: str, fn: Any) -> dict[str, Any]:
    try:
        value = fn()
        result = {"ok": True, "response": public(value)}
    except Exception as exc:  # noqa: BLE001
        result = {"ok": False, "error": error_shape(exc)}
    emit(label, result)
    return result


def main() -> None:
    client = anthropic.Anthropic()
    env_id = os.environ.get("OMA_PROBE_ENVIRONMENT_ID")
    agent_id: str | None = None
    idle_session_id: str | None = None
    running_session_id: str | None = None
    created_env_id: str | None = None
    observed_running_events: list[dict[str, Any]] = []

    try:
        if env_id is None:
            env = client.beta.environments.create(
                name=f"oma-agent-archive-probe-{RUN_ID}",
                config={"type": "cloud", "networking": {"type": "unrestricted"}},
            )
            env_id = env.id
            created_env_id = env.id
            emit("environment.created", env)
        else:
            emit("environment.provided", {"id": env_id})

        agent = client.beta.agents.create(
            name=f"oma-agent-archive-probe-{RUN_ID}",
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
        emit("agent.created.v1", agent)

        updated = client.beta.agents.update(
            agent_id,
            version=agent.version,
            name=f"oma-agent-archive-probe-{RUN_ID}-v2",
        )
        emit("agent.updated", updated)
        emit("agent.versions.before_archive", list(client.beta.agents.versions.list(agent_id, limit=10)))

        idle_session = client.beta.sessions.create(
            agent=agent_id,
            environment_id=env_id,
            title=f"oma-agent-archive-idle-session-{RUN_ID}",
        )
        idle_session_id = idle_session.id
        emit("session.created.before_archive", idle_session)

        running_session = client.beta.sessions.create(
            agent=agent_id,
            environment_id=env_id,
            title=f"oma-agent-archive-running-session-{RUN_ID}",
        )
        running_session_id = running_session.id
        emit("session.created.running_before_archive", running_session)

        archive_while_running: dict[str, Any] | None = None
        deadline = time.monotonic() + 180
        with client.beta.sessions.events.stream(running_session_id) as stream:
            send_response = client.beta.sessions.events.send(
                running_session_id,
                events=[
                    {
                        "type": "user.message",
                        "content": [
                            {
                                "type": "text",
                                "text": (
                                    "Use the bash tool exactly once. "
                                    "Run this exact command: "
                                    f"sleep 10; printf '{MARKER}\\n'. "
                                    "Do not answer from memory."
                                ),
                            }
                        ],
                    }
                ],
            )
            emit("events.send.running_session", send_response)
            attempted = False
            for event in stream:
                typ = event_type(event)
                observed_running_events.append(
                    {
                        "type": typ,
                        "name": getattr(event, "name", None),
                        "status": getattr(event, "status", None),
                    }
                )
                if not attempted and typ in {"session.status_running", "agent.tool_use"}:
                    attempted = True
                    archive_while_running = call(
                        "agents.archive.while_session_running",
                        lambda: client.beta.agents.archive(agent_id),
                    )
                if attempted and typ in {
                    "session.status_idle",
                    "session.status_terminated",
                    "session.error",
                }:
                    break
                if time.monotonic() > deadline:
                    raise TimeoutError("timed out waiting for running session to settle")
        emit("running_session.observed_events", observed_running_events)
        emit("running_session.retrieve.after_agent_archive_attempt", client.beta.sessions.retrieve(running_session_id))
        emit("running_session.events.after_agent_archive_attempt", list(client.beta.sessions.events.list(running_session_id, limit=50)))

        if archive_while_running is None or not archive_while_running["ok"]:
            call("agents.archive.after_running_session_settled", lambda: client.beta.agents.archive(agent_id))

        call("agents.archive.second_call", lambda: client.beta.agents.archive(agent_id))
        call("agents.retrieve.after_archive.default", lambda: client.beta.agents.retrieve(agent_id))
        call("agents.retrieve.after_archive.version_1", lambda: client.beta.agents.retrieve(agent_id, version=1))
        call("agents.retrieve.after_archive.current_version", lambda: client.beta.agents.retrieve(agent_id, version=updated.version))
        emit("agent.versions.after_archive", list(client.beta.agents.versions.list(agent_id, limit=10)))

        default_list = list(client.beta.agents.list(limit=20))
        archived_list = list(client.beta.agents.list(limit=20, include_archived=True))
        emit(
            "agents.list.after_archive",
            {
                "default_contains_agent": any(item.id == agent_id for item in default_list),
                "include_archived_contains_agent": any(item.id == agent_id for item in archived_list),
                "default_count": len(default_list),
                "include_archived_count": len(archived_list),
            },
        )

        call(
            "sessions.create.with_archived_agent",
            lambda: client.beta.sessions.create(
                agent=agent_id,
                environment_id=env_id,
                title=f"oma-agent-archive-after-agent-archive-{RUN_ID}",
            ),
        )
        call(
            "sessions.create.with_archived_agent_version_1",
            lambda: client.beta.sessions.create(
                agent={"type": "agent", "id": agent_id, "version": 1},
                environment_id=env_id,
                title=f"oma-agent-archive-after-agent-archive-v1-{RUN_ID}",
            ),
        )
        call(
            "sessions.create.with_archived_agent_current_version",
            lambda: client.beta.sessions.create(
                agent={"type": "agent", "id": agent_id, "version": updated.version},
                environment_id=env_id,
                title=f"oma-agent-archive-after-agent-archive-vcurrent-{RUN_ID}",
            ),
        )

        invalid_missing_id = "agent_01zzzzzzzzzzzzzzzzzzzzzz"
        call(
            "agents.archive.invalid_missing_id",
            lambda: client.beta.agents.archive(invalid_missing_id),
        )
        valid_missing_id = f"{agent_id[:-1]}Y" if agent_id[-1] != "Y" else f"{agent_id[:-1]}X"
        call(
            "agents.archive.valid_missing_id",
            lambda: client.beta.agents.archive(valid_missing_id),
        )

        emit(
            "verdict",
            {
                "archive_while_running_ok": bool(archive_while_running and archive_while_running["ok"]),
                "running_session_event_types": [item["type"] for item in observed_running_events],
            },
        )
    finally:
        for sid in [running_session_id, idle_session_id]:
            if sid:
                try:
                    emit(f"session.delete.cleanup.{sid}", client.beta.sessions.delete(sid))
                except Exception as exc:  # noqa: BLE001
                    emit(f"session.delete.cleanup.{sid}.error", error_shape(exc))
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
