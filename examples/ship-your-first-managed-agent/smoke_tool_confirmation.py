#!/usr/bin/env python3
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
"""Headless OMA smoke for ask-gated builtin tool confirmation."""

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


def event_type(event: dict[str, Any]) -> str:
    return str(event.get("type", ""))


def stop_reason_type(event: dict[str, Any]) -> str | None:
    stop_reason = event.get("stop_reason")
    return stop_reason.get("type") if isinstance(stop_reason, dict) else None


def compact(event: Any) -> dict[str, Any]:
    data = public(event)
    return {
        "id": data.get("id"),
        "type": data.get("type"),
        "name": data.get("name"),
        "tool_use_id": data.get("tool_use_id"),
        "evaluated_permission": data.get("evaluated_permission"),
        "stop_reason": data.get("stop_reason"),
        "model_request_start_id": data.get("model_request_start_id"),
        "is_error": data.get("is_error"),
    }


def create_gated_agent() -> str:
    agent = agent_core.client.beta.agents.create(
        name=f"OMA gated builtin smoke {uuid.uuid4().hex[:6]}",
        model=agent_core.MODEL,
        system=(
            "You are a deterministic smoke-test agent. Use bash when the user "
            "asks for bash. After the tool result, answer with the requested "
            "marker and no extra prose."
        ),
        tools=[
            {
                "type": "agent_toolset_20260401",
                "default_config": {
                    "enabled": True,
                    "permission_policy": {"type": "always_ask"},
                },
            }
        ],
    )
    return agent.id


def create_session(agent_id: str, environment_id: str) -> str:
    session = agent_core.client.beta.sessions.create(
        agent=agent_id,
        environment_id=environment_id,
        title="OMA ask-gated builtin smoke",
    )
    return session.id


def list_events(session_id: str) -> list[dict[str, Any]]:
    page = agent_core.client.beta.sessions.events.list(
        session_id,
        order="asc",
        limit=500,
    )
    return [public(event) for event in page.data]


def require_order(events: list[dict[str, Any]]) -> dict[str, Any]:
    types = [event_type(event) for event in events]
    span_start_index = types.index("span.model_request_start")
    tool_use_index = next(
        index
        for index, event in enumerate(events)
        if event_type(event) == "agent.tool_use"
        and event.get("evaluated_permission") == "ask"
    )
    span_end_index = types.index("span.model_request_end")
    requires_action_index = next(
        index
        for index, event in enumerate(events)
        if event_type(event) == "session.status_idle"
        and stop_reason_type(event) == "requires_action"
    )
    confirmation_index = types.index("user.tool_confirmation")
    tool_result_index = types.index("agent.tool_result")
    final_idle_index = next(
        index
        for index, event in enumerate(events)
        if event_type(event) == "session.status_idle"
        and stop_reason_type(event) == "end_turn"
    )

    if not span_start_index < tool_use_index < span_end_index < requires_action_index:
        raise RuntimeError(
            "expected span start -> ask tool_use -> span end -> requires_action"
        )
    if not requires_action_index < confirmation_index < tool_result_index < final_idle_index:
        raise RuntimeError(
            "expected requires_action -> confirmation -> tool_result -> final idle"
        )

    tool_use = events[tool_use_index]
    requires_action = events[requires_action_index]
    if requires_action.get("stop_reason", {}).get("event_ids") != [tool_use.get("id")]:
        raise RuntimeError("requires_action.event_ids did not match ask tool_use id")
    if events[confirmation_index].get("tool_use_id") != tool_use.get("id"):
        raise RuntimeError("confirmation did not target ask tool_use id")
    if events[tool_result_index].get("tool_use_id") != tool_use.get("id"):
        raise RuntimeError("tool_result did not target ask tool_use id")
    if events[tool_result_index].get("is_error") is not False:
        raise RuntimeError("allowed tool_result unexpectedly had is_error=true")

    span_end = events[span_end_index]
    if span_end.get("model_request_start_id") != events[span_start_index].get("id"):
        raise RuntimeError("span end did not point at span start")
    if span_end.get("is_error") not in {False, None}:
        raise RuntimeError("span end was unexpectedly marked as an error")

    return {
        "span_start_index": span_start_index,
        "tool_use_index": tool_use_index,
        "span_end_index": span_end_index,
        "requires_action_index": requires_action_index,
        "confirmation_index": confirmation_index,
        "tool_result_index": tool_result_index,
        "final_idle_index": final_idle_index,
        "tool_use_id": tool_use.get("id"),
    }


def main() -> int:
    created: dict[str, str] = {}
    stream_events: list[dict[str, Any]] = []
    confirmed_tool_use_id: str | None = None
    sent_confirmation = False

    try:
        emit(
            "smoke.config",
            {
                "base_url": agent_core.BASE_URL,
                "beta": agent_core.BETA,
                "model": agent_core.MODEL,
            },
        )
        agent_id = create_gated_agent()
        created["agent_id"] = agent_id
        emit("agent.created", {"id": agent_id})

        environment_id = agent_core.create_environment(
            f"oma-gated-smoke-{uuid.uuid4().hex[:6]}",
        )
        created["environment_id"] = environment_id
        emit("environment.created", {"id": environment_id})

        session_id = create_session(agent_id, environment_id)
        created["session_id"] = session_id
        emit("session.created", {"id": session_id})

        prompt = (
            "Use bash exactly once to run: printf 'GATED_SMOKE_OK\\n'. "
            "After the tool result, reply exactly GATED_SMOKE_DONE."
        )
        deadline = time.monotonic() + 240
        with agent_core.client.beta.sessions.events.stream(session_id) as stream:
            agent_core.client.beta.sessions.events.send(
                session_id,
                events=[
                    {
                        "type": "user.message",
                        "content": [{"type": "text", "text": prompt}],
                    }
                ],
            )
            for event in stream:
                row = compact(event)
                stream_events.append(row)
                if (
                    row["type"] == "agent.tool_use"
                    and row["evaluated_permission"] == "ask"
                    and isinstance(row["id"], str)
                ):
                    confirmed_tool_use_id = row["id"]
                if (
                    row["type"] == "session.status_idle"
                    and stop_reason_type(row) == "requires_action"
                    and confirmed_tool_use_id
                    and not sent_confirmation
                ):
                    agent_core.client.beta.sessions.events.send(
                        session_id,
                        events=[
                            {
                                "type": "user.tool_confirmation",
                                "tool_use_id": confirmed_tool_use_id,
                                "result": "allow",
                            }
                        ],
                    )
                    sent_confirmation = True
                if row["type"] == "session.status_idle" and stop_reason_type(row) == "end_turn":
                    break
                if time.monotonic() > deadline:
                    raise TimeoutError("timed out waiting for ask-gated smoke completion")

        listed = list_events(session_id)
        order = require_order(listed)
        listed_types = [event_type(event) for event in listed]
        verdict = {
            "pass": True,
            "stream_types": [event_type(event) for event in stream_events],
            "listed_types": listed_types,
            "order": order,
            "span_closed_before_requires_action": (
                order["span_end_index"] < order["requires_action_index"]
            ),
        }
        emit("verdict", verdict)
        return 0
    except Exception as exc:  # noqa: BLE001
        emit(
            "smoke.error",
            {
                "type": type(exc).__name__,
                "message": str(exc),
                "created": created,
                "stream_events": stream_events,
            },
        )
        return 2
    finally:
        session_id = created.get("session_id")
        if session_id:
            try:
                emit("session.deleted", agent_core.client.beta.sessions.delete(session_id))
            except Exception as exc:  # noqa: BLE001
                emit("session.delete.error", {"type": type(exc).__name__, "message": str(exc)})
        agent_id = created.get("agent_id")
        if agent_id:
            try:
                emit("agent.archived", agent_core.client.beta.agents.archive(agent_id))
            except Exception as exc:  # noqa: BLE001
                emit("agent.archive.error", {"type": type(exc).__name__, "message": str(exc)})
        environment_id = created.get("environment_id")
        if environment_id:
            emit(
                "environment.delete.skipped",
                {
                    "id": environment_id,
                    "reason": "local OMA does not expose environment deletion",
                },
            )


if __name__ == "__main__":
    sys.exit(main())
