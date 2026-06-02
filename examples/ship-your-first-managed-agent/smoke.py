#!/usr/bin/env python3
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
"""Headless OMA smoke for the Streamlit dashboard example."""

from __future__ import annotations

import json
import sys
import time
import uuid
from typing import Any

from dotenv import load_dotenv

import agent_core

load_dotenv()


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


def text_from_blocks(blocks: Any) -> str:
    out: list[str] = []
    for block in blocks or []:
        if getattr(block, "type", None) == "text":
            out.append(getattr(block, "text", ""))
    return "".join(out)


def main() -> int:
    created: dict[str, str] = {}
    events_seen: list[str] = []
    replay_types: list[str] = []
    transcript: list[str] = []
    builtin_tool_calls: list[str] = []
    custom_tool_calls: list[str] = []

    try:
        emit(
            "smoke.config",
            {
                "base_url": agent_core.BASE_URL,
                "beta": agent_core.BETA,
                "model": agent_core.MODEL,
            },
        )

        agent_id = agent_core.create_agent(f"OMA SRE Smoke {uuid.uuid4().hex[:6]}")
        created["agent_id"] = agent_id
        emit("agent.created", {"id": agent_id})

        environment_id = agent_core.create_environment(
            f"oma-sre-smoke-{uuid.uuid4().hex[:6]}",
        )
        created["environment_id"] = environment_id
        emit("environment.created", {"id": environment_id})

        log_file_id = agent_core.upload_log()
        created["file_id"] = log_file_id
        emit("file.uploaded", {"id": log_file_id})

        session_id = agent_core.start_session(agent_id, environment_id, log_file_id)
        created["session_id"] = session_id
        emit("session.created", {"id": session_id})

        deadline = time.monotonic() + 300
        for event in agent_core.stream_reply(
            session_id,
            (
                "checkout p99 spiked around 14:32 UTC. "
                "Before your final answer, you must use bash on "
                "/mnt/session/uploads/app.log, call get_metrics for checkout "
                "p99_latency_ms, call get_recent_deploys, and call get_diff "
                "for the suspicious commit. Then identify the root cause."
            ),
        ):
            event_type = str(getattr(event, "type", ""))
            events_seen.append(event_type)
            if event_type == "agent.message":
                transcript.append(text_from_blocks(getattr(event, "content", [])))
            elif event_type == "agent.tool_use":
                builtin_tool_calls.append(str(getattr(event, "name", "")))
            elif event_type == "agent.custom_tool_use":
                custom_tool_calls.append(str(getattr(event, "name", "")))
            elif event_type == "session.status_idle":
                stop_reason = getattr(event, "stop_reason", None)
                if getattr(stop_reason, "type", None) == "end_turn":
                    break
            if time.monotonic() > deadline:
                raise TimeoutError("timed out waiting for end_turn")

        listed = agent_core.client.beta.sessions.events.list(
            session_id,
            order="asc",
            limit=500,
        )
        replay_types = [str(getattr(event, "type", "")) for event in listed.data]
        full = "".join(transcript).lower()
        expected_custom = {"get_metrics", "get_recent_deploys", "get_diff"}
        verdict = {
            "events_seen": events_seen,
            "replay_types": replay_types,
            "builtin_tool_calls": builtin_tool_calls,
            "custom_tool_calls": custom_tool_calls,
            "saw_tool_result": "agent.tool_result" in replay_types,
            "saw_custom_tool_result": "user.custom_tool_result" in replay_types,
            "mentions_bad_commit": "a3f9c21" in full,
            "mentions_n_plus_one": "n+1" in full or "n + 1" in full,
            "assistant_text_preview": "".join(transcript)[-1000:],
        }
        verdict["pass"] = (
            bool(builtin_tool_calls)
            and expected_custom.issubset(set(custom_tool_calls))
            and verdict["saw_tool_result"]
            and verdict["saw_custom_tool_result"]
            and verdict["mentions_bad_commit"]
            and verdict["mentions_n_plus_one"]
        )
        emit("verdict", verdict)
        return 0 if verdict["pass"] else 1
    except Exception as exc:  # noqa: BLE001
        emit(
            "smoke.error",
            {
                "type": type(exc).__name__,
                "message": str(exc),
                "created": created,
                "events_seen": events_seen,
                "replay_types": replay_types,
            },
        )
        return 2
    finally:
        session_id = created.get("session_id")
        if session_id:
            try:
                emit(
                    "session.deleted",
                    agent_core.client.beta.sessions.delete(session_id),
                )
            except Exception as exc:  # noqa: BLE001
                emit("session.delete.error", {"type": type(exc).__name__, "message": str(exc)})
        file_id = created.get("file_id")
        if file_id:
            try:
                emit("file.deleted", agent_core.client.beta.files.delete(file_id))
            except Exception as exc:  # noqa: BLE001
                emit("file.delete.error", {"type": type(exc).__name__, "message": str(exc)})


if __name__ == "__main__":
    sys.exit(main())
