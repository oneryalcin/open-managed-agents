#!/usr/bin/env python3
"""Live smoke: upload a file, mount it into a Managed Agents session, cat it.

This probe intentionally performs one small model turn. Default model is
`claude-sonnet-4-6`; override with OMA_RESOURCE_PROBE_MODEL if needed.
Requires ANTHROPIC_API_KEY. Optional:
  OMA_PROBE_ENVIRONMENT_ID
"""

from __future__ import annotations

import io
import json
import os
import time
from typing import Any

import anthropic


MODEL = os.environ.get("OMA_RESOURCE_PROBE_MODEL", "claude-sonnet-4-6")
PAYLOAD = "OMA_RESOURCE_PROBE=ok\n"
MOUNT_PATH = "/mnt/session/uploads/probe.txt"


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


def first_id(items: Any) -> str:
    for item in items:
        return item.id
    raise RuntimeError("no items available")


def main() -> None:
    client = anthropic.Anthropic()
    env_id = os.environ.get("OMA_PROBE_ENVIRONMENT_ID") or first_id(
        client.beta.environments.list(limit=1)
    )
    agent_id: str | None = None
    session_id: str | None = None
    file_id: str | None = None

    try:
        agent = client.beta.agents.create(
            name=f"oma-resource-cat-probe-{int(time.time())}",
            model=MODEL,
            system=(
                f"The file is mounted at {MOUNT_PATH}. When the user asks, "
                "use bash to read it and then reply with exactly the file "
                "contents and nothing else."
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
        emit("agent.created", {"id": agent.id, "model": MODEL})

        uploaded = client.beta.files.upload(
            file=("oma-resource-probe.txt", io.BytesIO(PAYLOAD.encode()), "text/plain")
        )
        file_id = uploaded.id
        emit("file.uploaded", uploaded)

        session = client.beta.sessions.create(
            agent=agent.id,
            environment_id=env_id,
            title="oma-resource-cat-probe",
            resources=[
                {"type": "file", "file_id": uploaded.id, "mount_path": "probe.txt"}
            ],
        )
        session_id = session.id
        emit("session.created", {
            "id": session.id,
            "resources": getattr(session, "resources", None),
        })

        transcript: list[str] = []
        event_types: list[str] = []
        tool_uses: list[str] = []
        deadline = time.monotonic() + 180
        with client.beta.sessions.events.stream(session.id) as stream:
            client.beta.sessions.events.send(
                session.id,
                events=[
                    {
                        "type": "user.message",
                        "content": [
                            {
                                "type": "text",
                                "text": f"Read {MOUNT_PATH} with bash.",
                            }
                        ],
                    }
                ],
            )
            for event in stream:
                event_type = getattr(event, "type", None)
                event_types.append(str(event_type))
                if event_type == "agent.tool_use":
                    tool_uses.append(getattr(event, "name", ""))
                if event_type == "agent.message":
                    for block in getattr(event, "content", []) or []:
                        if getattr(block, "type", None) == "text":
                            transcript.append(getattr(block, "text", ""))
                if event_type == "session.status_idle":
                    break
                if time.monotonic() > deadline:
                    raise TimeoutError("timed out waiting for session idle")

        text = "".join(transcript)
        emit(
            "verdict",
            {
                "event_types": event_types,
                "tool_uses": tool_uses,
                "assistant_text": text,
                "content_matches": text.strip() == PAYLOAD.strip(),
            },
        )
    finally:
        if session_id:
            try:
                emit("session.deleted", client.beta.sessions.delete(session_id))
            except Exception as exc:  # noqa: BLE001
                emit("session.delete.error", {"type": type(exc).__name__, "message": str(exc)})
        if agent_id:
            try:
                archived = client.beta.agents.archive(agent_id)
                emit("agent.archived", {"id": archived.id, "archived_at": getattr(archived, "archived_at", None)})
            except Exception as exc:  # noqa: BLE001
                emit("agent.archive.error", {"type": type(exc).__name__, "message": str(exc)})
        if file_id:
            try:
                emit("file.deleted", client.beta.files.delete(file_id))
            except Exception as exc:  # noqa: BLE001
                emit("file.delete.error", {"type": type(exc).__name__, "message": str(exc)})


if __name__ == "__main__":
    main()

