#!/usr/bin/env python3
"""Sanitized live probe for Anthropic Managed Agents file/session resources.

Requires ANTHROPIC_API_KEY in the environment. Optional:
  OMA_PROBE_AGENT_ID
  OMA_PROBE_ENVIRONMENT_ID

The probe avoids model turns: it uploads a tiny file, creates sessions with
different resource mount shapes, inspects resource metadata, then deletes
created sessions and the uploaded file where the API permits.
"""

from __future__ import annotations

import io
import json
import os
from typing import Any

import anthropic


def public(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [public(item) for item in value]
    if isinstance(value, dict):
        return {str(k): public(v) for k, v in value.items()}
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
    body = getattr(exc, "body", None)
    return {
        "type": type(exc).__name__,
        "status_code": getattr(exc, "status_code", None),
        "message": str(exc)[:500],
        "body": public(body),
    }


def first_id(items: Any) -> str:
    for item in items:
        return item.id
    raise RuntimeError("no items available")


def main() -> None:
    client = anthropic.Anthropic()
    agent_id = os.environ.get("OMA_PROBE_AGENT_ID") or first_id(
        client.beta.agents.list(limit=1)
    )
    env_id = os.environ.get("OMA_PROBE_ENVIRONMENT_ID") or first_id(
        client.beta.environments.list(limit=1)
    )
    emit("probe_target", {"agent_id": agent_id, "environment_id": env_id})

    created_sessions: list[str] = []
    uploaded_file_id: str | None = None
    payload = b"OMA_RESOURCE_PROBE=ok\n"

    try:
        file_obj = io.BytesIO(payload)
        uploaded = client.beta.files.upload(
            file=("oma-resource-probe.txt", file_obj, "text/plain")
        )
        uploaded_file_id = uploaded.id
        emit("files.upload", uploaded)
        emit("files.retrieve_metadata", client.beta.files.retrieve_metadata(uploaded.id))
        try:
            downloaded = client.beta.files.download(uploaded.id)
            emit(
                "files.download",
                {
                    "type": type(downloaded).__name__,
                    "byte_length": len(downloaded.content)
                    if hasattr(downloaded, "content")
                    else None,
                    "content_matches": getattr(downloaded, "content", None) == payload,
                },
            )
        except Exception as exc:  # noqa: BLE001
            emit("files.download.error", error_shape(exc))

        cases = [
            ("relative_mount", {"mount_path": "probe.txt"}),
            ("nested_relative_mount", {"mount_path": "data/probe.txt"}),
            ("omitted_mount_path", {}),
            ("absolute_mount_path", {"mount_path": "/tmp/probe.txt"}),
            ("path_traversal_mount_path", {"mount_path": "../probe.txt"}),
            ("duplicate_mount_path", {"mount_path": "dupe.txt", "duplicate": True}),
        ]

        for label, opts in cases:
            resources = [
                {
                    "type": "file",
                    "file_id": uploaded.id,
                    **{
                        key: value
                        for key, value in opts.items()
                        if key != "duplicate"
                    },
                }
            ]
            if opts.get("duplicate"):
                resources.append(
                    {
                        "type": "file",
                        "file_id": uploaded.id,
                        "mount_path": opts["mount_path"],
                    }
                )
            try:
                session = client.beta.sessions.create(
                    agent=agent_id,
                    environment_id=env_id,
                    title=f"oma-resource-probe-{label}",
                    resources=resources,
                )
                created_sessions.append(session.id)
                emit(f"sessions.create.{label}", session)
                emit(
                    f"sessions.resources.list.{label}",
                    list(client.beta.sessions.resources.list(session.id, limit=10)),
                )
            except Exception as exc:  # noqa: BLE001
                emit(f"sessions.create.{label}.error", error_shape(exc))
    finally:
        for session_id in created_sessions:
            try:
                emit(
                    f"sessions.delete.{session_id}",
                    client.beta.sessions.delete(session_id),
                )
            except Exception as exc:  # noqa: BLE001
                emit(f"sessions.delete.{session_id}.error", error_shape(exc))
        if uploaded_file_id:
            try:
                emit("files.delete", client.beta.files.delete(uploaded_file_id))
            except Exception as exc:  # noqa: BLE001
                emit("files.delete.error", error_shape(exc))


if __name__ == "__main__":
    main()
