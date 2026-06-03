#!/usr/bin/env python3
"""Probe hosted CMA session-scoped output file listing/download behavior."""

from __future__ import annotations

import io
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import anthropic
from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = Path(
    os.environ.get(
        "OMA_CWC_ENV_PATH",
        "/Users/mehmetoneryalcin/dev/junk/cwc-workshops/ship-your-first-managed-agent/.env",
    )
)
ARTIFACT = ROOT / "scratch" / "artifacts" / "39-hosted-session-output-files-probe.json"
BETA = "managed-agents-2026-04-01"
MODEL = os.environ.get("OMA_HOSTED_OUTPUT_PROBE_MODEL", "claude-sonnet-4-6")


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


def file_row(value: Any) -> dict[str, Any]:
    data = public(value)
    if not isinstance(data, dict):
        return {"repr": repr(value)}
    return {
        key: data.get(key)
        for key in [
            "id",
            "type",
            "filename",
            "mime_type",
            "size_bytes",
            "downloadable",
            "scope",
            "created_at",
        ]
        if key in data
    }


def text_from_blocks(blocks: Any) -> str:
    out: list[str] = []
    for block in blocks or []:
        if getattr(block, "type", None) == "text":
            out.append(getattr(block, "text", ""))
    return "".join(out)


def list_session_files(client: anthropic.Anthropic, session_id: str) -> list[Any]:
    page = client.beta.files.list(
        scope_id=session_id,
        betas=[BETA],
    )
    return list(page.data)


def content_bytes(downloaded: Any) -> bytes:
    if isinstance(downloaded, bytes):
        return downloaded
    if hasattr(downloaded, "read"):
        return downloaded.read()
    if hasattr(downloaded, "content"):
        content = downloaded.content
        if isinstance(content, bytes):
            return content
    if hasattr(downloaded, "iter_bytes"):
        return b"".join(downloaded.iter_bytes())
    raise TypeError(f"Unsupported download object: {type(downloaded)!r}")


def main() -> int:
    load_dotenv(ENV_PATH)
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(f"ANTHROPIC_API_KEY missing in {ENV_PATH}")

    client = anthropic.Anthropic(
        api_key=api_key,
        default_headers={"anthropic-beta": BETA},
        max_retries=0,
        timeout=180,
    )
    suffix = uuid.uuid4().hex[:8]
    created: dict[str, str] = {}
    result: dict[str, Any] = {
        "beta": BETA,
        "model": MODEL,
        "env_path": str(ENV_PATH),
        "created": created,
        "events": [],
        "downloads": {},
        "cleanup": {},
    }

    try:
        agent = client.beta.agents.create(
            name=f"oma-output-probe-{suffix}",
            model=MODEL,
            system=(
                "You are an output file probe agent. When asked, use bash exactly "
                "as instructed. Do not browse. Keep the final answer short."
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
        created["agent_id"] = agent.id

        env = client.beta.environments.create(
            name=f"oma-output-probe-{suffix}",
            config={"type": "cloud", "networking": {"type": "unrestricted"}},
        )
        created["environment_id"] = env.id

        uploaded = client.beta.files.upload(
            file=(
                "probe-input.txt",
                io.BytesIO(b"hosted-output-probe-input\n"),
                "text/plain",
            ),
        )
        created["uploaded_file_id"] = uploaded.id
        result["uploaded_file"] = file_row(uploaded)

        session = client.beta.sessions.create(
            agent=agent.id,
            environment_id=env.id,
            title=f"OMA output probe {suffix}",
            resources=[
                {
                    "type": "file",
                    "file_id": uploaded.id,
                    "mount_path": "probe-input.txt",
                }
            ],
        )
        created["session_id"] = session.id

        result["files_before_message"] = [
            file_row(f) for f in list_session_files(client, session.id)
        ]

        prompt = (
            "Use bash to run these exact effects: "
            "mkdir -p /mnt/session/outputs/nested; "
            "printf 'root-output-39\\n' > /mnt/session/outputs/root.txt; "
            "printf 'nested-output-39\\n' > /mnt/session/outputs/nested/child.txt; "
            "cat /mnt/session/uploads/probe-input.txt >/tmp/probe-input-copy.txt; "
            "then verify both output files exist. Final answer: done."
        )

        transcript: list[str] = []
        with client.beta.sessions.events.stream(session.id) as stream:
            client.beta.sessions.events.send(
                session.id,
                events=[
                    {
                        "type": "user.message",
                        "content": [{"type": "text", "text": prompt}],
                    }
                ],
            )
            deadline = time.monotonic() + 180
            for event in stream:
                event_type = str(getattr(event, "type", ""))
                result["events"].append(event_type)
                if event_type == "agent.message":
                    transcript.append(text_from_blocks(getattr(event, "content", [])))
                if event_type == "session.status_idle":
                    stop_reason = getattr(event, "stop_reason", None)
                    if getattr(stop_reason, "type", None) != "requires_action":
                        break
                if time.monotonic() > deadline:
                    raise TimeoutError("timed out waiting for terminal idle")

        result["assistant_text"] = "".join(transcript)

        files_after: list[Any] = []
        for attempt in range(10):
            files_after = list_session_files(client, session.id)
            names = {str(getattr(f, "filename", "")) for f in files_after}
            if {"root.txt", "nested/child.txt"}.issubset(names) or {
                "root.txt",
                "child.txt",
            }.issubset(names):
                break
            time.sleep(min(2**attempt, 8))

        result["files_after_idle"] = [file_row(f) for f in files_after]
        for file in files_after:
            row = file_row(file)
            if row.get("downloadable") is not True:
                continue
            try:
                downloaded = client.beta.files.download(file.id)
                body = content_bytes(downloaded)
                result["downloads"][file.id] = {
                    "filename": row.get("filename"),
                    "size": len(body),
                    "text": body.decode("utf-8", "replace"),
                }
            except Exception as exc:  # noqa: BLE001
                result["downloads"][file.id] = {
                    "filename": row.get("filename"),
                    "error_type": type(exc).__name__,
                    "error": str(exc),
                }

        ARTIFACT.write_text(json.dumps(result, indent=2, sort_keys=True))
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    finally:
        session_id = created.get("session_id")
        if session_id:
            try:
                result["cleanup"]["session"] = public(
                    client.beta.sessions.delete(session_id)
                )
            except Exception as exc:  # noqa: BLE001
                result["cleanup"]["session_error"] = {
                    "type": type(exc).__name__,
                    "message": str(exc),
                }
        file_id = created.get("uploaded_file_id")
        if file_id:
            try:
                result["cleanup"]["uploaded_file"] = public(
                    client.beta.files.delete(file_id)
                )
            except Exception as exc:  # noqa: BLE001
                result["cleanup"]["uploaded_file_error"] = {
                    "type": type(exc).__name__,
                    "message": str(exc),
                }
        agent_id = created.get("agent_id")
        if agent_id:
            try:
                result["cleanup"]["agent"] = public(client.beta.agents.archive(agent_id))
            except Exception as exc:  # noqa: BLE001
                result["cleanup"]["agent_error"] = {
                    "type": type(exc).__name__,
                    "message": str(exc),
                }
        environment_id = created.get("environment_id")
        if environment_id:
            try:
                result["cleanup"]["environment"] = public(
                    client.beta.environments.archive(environment_id)
                )
            except Exception as exc:  # noqa: BLE001
                result["cleanup"]["environment_error"] = {
                    "type": type(exc).__name__,
                    "message": str(exc),
                }
        ARTIFACT.write_text(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    sys.exit(main())
