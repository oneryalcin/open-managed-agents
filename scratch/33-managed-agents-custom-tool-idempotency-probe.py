#!/usr/bin/env python3
"""Live probe: hosted custom-tool-result duplicate/idempotency behavior.

Questions:
  1. What happens if the same user.custom_tool_result is submitted twice
     without an idempotency key?
  2. Does the hosted API replay/dedupe when both attempts use the same
     Idempotency-Key header?

Requires:
  ANTHROPIC_API_KEY

Optional:
  OMA_IDEMPOTENCY_PROBE_MODEL (default: claude-haiku-4-5)
  OMA_IDEMPOTENCY_PROBE_STATE (default: scratch/artifacts/...<run>.state.json)

Run:
  uv run --with anthropic python scratch/33-managed-agents-custom-tool-idempotency-probe.py
  uv run --with anthropic python scratch/33-managed-agents-custom-tool-idempotency-probe.py --cleanup-state scratch/artifacts/<state-file>.state.json
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import time
from typing import Any

import anthropic


MODEL = os.environ.get("OMA_IDEMPOTENCY_PROBE_MODEL", "claude-haiku-4-5")
RUN_ID = f"{int(time.time())}-{os.getpid()}"
TOOL_NAME = "ask_idempotency_probe"
STATE_PATH = Path(
    os.environ.get(
        "OMA_IDEMPOTENCY_PROBE_STATE",
        f"scratch/artifacts/33-managed-agents-custom-tool-idempotency-probe-{RUN_ID}.state.json",
    )
)


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


def write_state(
    state_path: Path,
    *,
    env_id: str | None,
    agent_ids: list[str],
    session_ids: list[str],
) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(
        json.dumps(
            {
                "run_id": RUN_ID,
                "environment_id": env_id,
                "agent_ids": agent_ids,
                "session_ids": session_ids,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )


def cleanup_resources(
    client: anthropic.Anthropic,
    *,
    env_id: str | None,
    agent_ids: list[str],
    session_ids: list[str],
) -> bool:
    ok = True
    for session_id in session_ids:
        try:
            emit("session.delete.cleanup", client.beta.sessions.delete(session_id))
        except Exception as exc:  # noqa: BLE001
            emit("session.delete.cleanup.first_error", error_shape(exc))
            try:
                client.beta.sessions.events.send(
                    session_id,
                    events=[{"type": "user.interrupt"}],
                )
                time.sleep(2)
                emit(
                    "session.delete.cleanup.after_interrupt",
                    client.beta.sessions.delete(session_id),
                )
            except Exception as retry_exc:  # noqa: BLE001
                ok = False
                emit("session.delete.cleanup.retry_error", error_shape(retry_exc))
    for agent_id in agent_ids:
        try:
            archived = client.beta.agents.archive(agent_id)
            emit(
                "agent.archive.cleanup",
                {"id": agent_id, "archived_at": getattr(archived, "archived_at", None)},
            )
        except Exception as exc:  # noqa: BLE001
            ok = False
            emit("agent.archive.cleanup.error", error_shape(exc))
    if env_id:
        try:
            emit("environment.delete.cleanup", client.beta.environments.delete(env_id))
        except Exception as exc:  # noqa: BLE001
            ok = False
            emit("environment.delete.cleanup.error", error_shape(exc))
    return ok


def cleanup_from_state(client: anthropic.Anthropic, state_path: Path) -> None:
    state = json.loads(state_path.read_text())
    ok = cleanup_resources(
        client,
        env_id=state.get("environment_id"),
        agent_ids=list(state.get("agent_ids") or []),
        session_ids=list(state.get("session_ids") or []),
    )
    if ok:
        state_path.unlink(missing_ok=True)


def error_shape(exc: BaseException) -> dict[str, Any]:
    return {
        "type": type(exc).__name__,
        "status_code": getattr(exc, "status_code", None),
        "message": str(exc)[:1000],
        "body": redact_request_ids(public(getattr(exc, "body", None))),
    }


def redact_request_ids(value: Any) -> Any:
    if isinstance(value, list):
        return [redact_request_ids(item) for item in value]
    if isinstance(value, dict):
        return {
            str(key): "<redacted_request_id>"
            if str(key) == "request_id" and isinstance(val, str)
            else redact_request_ids(val)
            for key, val in value.items()
        }
    return value


def event_type(event: Any) -> str:
    return str(getattr(event, "type", ""))


def is_requires_action(event: Any) -> bool:
    if event_type(event) != "session.status_idle":
        return False
    stop_reason = getattr(event, "stop_reason", None)
    return getattr(stop_reason, "type", None) == "requires_action"


def get_event_ids(event: Any) -> list[str]:
    stop_reason = getattr(event, "stop_reason", None)
    ids = getattr(stop_reason, "event_ids", None)
    return [str(item) for item in ids or []]


def send_result(
    client: anthropic.Anthropic,
    session_id: str,
    custom_tool_use_id: str,
    answer: str,
    *,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
    try:
        response = client.beta.sessions.events.send(
            session_id,
            events=[
                {
                    "type": "user.custom_tool_result",
                    "custom_tool_use_id": custom_tool_use_id,
                    "content": [{"type": "text", "text": answer}],
                    "is_error": False,
                }
            ],
            extra_headers=headers,
        )
        return {"ok": True, "response": public(response)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": error_shape(exc)}


def response_event_id(result: dict[str, Any]) -> str | None:
    value = result.get("response", {}).get("data", [{}])[0].get("id")
    return value if isinstance(value, str) else None


def list_events(client: anthropic.Anthropic, session_id: str) -> list[Any]:
    return list(client.beta.sessions.events.list(session_id, limit=100, order="asc"))


def stop_reason_type(event: Any) -> str | None:
    stop_reason = getattr(event, "stop_reason", None)
    value = getattr(stop_reason, "type", None)
    return str(value) if value is not None else None


def processed_at(event: Any) -> Any:
    return getattr(event, "processed_at", None)


def marker_time(events: list[Any], event_id: str) -> Any:
    for event in events:
        if getattr(event, "id", None) == event_id:
            return processed_at(event)
    return None


def is_after_marker(event: Any, marker: Any, *, seen_after_marker: bool) -> bool:
    event_time = processed_at(event)
    if marker is not None and event_time is not None:
        return event_time > marker
    return seen_after_marker


def wait_for_end_turn(
    client: anthropic.Anthropic,
    session_id: str,
    *,
    after_event_id: str,
) -> list[Any]:
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        events = list_events(client, session_id)
        seen_after = False
        after_time = marker_time(events, after_event_id)
        for event in events:
            if getattr(event, "id", None) == after_event_id:
                seen_after = True
            if (
                is_after_marker(event, after_time, seen_after_marker=seen_after)
                and event_type(event) == "session.status_idle"
                and stop_reason_type(event) == "end_turn"
            ):
                return events
        time.sleep(1)
    raise TimeoutError(f"timed out waiting for end_turn after {after_event_id}")


def wait_for_duplicate_settled(
    client: anthropic.Anthropic,
    session_id: str,
    *,
    after_event_id: str,
) -> tuple[str, list[Any]]:
    deadline = time.monotonic() + 120
    last_count = -1
    stable_since: float | None = None
    while time.monotonic() < deadline:
        events = list_events(client, session_id)
        seen_after = False
        after_time = marker_time(events, after_event_id)
        for event in events:
            if getattr(event, "id", None) == after_event_id:
                seen_after = True
            if (
                is_after_marker(event, after_time, seen_after_marker=seen_after)
                and event_type(event) == "session.status_idle"
                and stop_reason_type(event) == "end_turn"
            ):
                return "end_turn", events
        if seen_after:
            if len(events) != last_count:
                last_count = len(events)
                stable_since = time.monotonic()
            elif stable_since is not None and time.monotonic() - stable_since >= 5:
                return "stable", events
        time.sleep(1)
    raise TimeoutError(f"timed out waiting for duplicate to settle after {after_event_id}")


def event_count(events: list[Any], event_type_name: str) -> int:
    return sum(1 for event in events if event_type(event) == event_type_name)


def create_requires_action_session(
    client: anthropic.Anthropic,
    env_id: str,
    scenario: str,
    created_agent_ids: list[str],
    created_session_ids: list[str],
    state_path: Path,
) -> tuple[str, str, str, list[dict[str, Any]]]:
    agent = client.beta.agents.create(
        name=f"oma-idempotency-probe-{scenario}-{RUN_ID}",
        model=MODEL,
        system=(
            f"You have one custom tool named {TOOL_NAME}. "
            "When asked, call it exactly once and wait for the result. "
            "After the result arrives, reply with exactly the tool result text."
        ),
        tools=[
            {
                "type": "custom",
                "name": TOOL_NAME,
                "description": "Ask the API caller for idempotency probe input.",
                "input_schema": {
                    "type": "object",
                    "properties": {"question": {"type": "string"}},
                    "required": ["question"],
                },
            }
        ],
    )
    created_agent_ids.append(agent.id)
    write_state(
        state_path,
        env_id=env_id,
        agent_ids=created_agent_ids,
        session_ids=created_session_ids,
    )
    session = client.beta.sessions.create(
        agent=agent.id,
        environment_id=env_id,
        title=f"oma-idempotency-probe-{scenario}-{RUN_ID}",
    )
    created_session_ids.append(session.id)
    write_state(
        state_path,
        env_id=env_id,
        agent_ids=created_agent_ids,
        session_ids=created_session_ids,
    )
    observed: list[dict[str, Any]] = []
    with client.beta.sessions.events.stream(session.id, timeout=30) as stream:
        client.beta.sessions.events.send(
            session.id,
            events=[
                {
                    "type": "user.message",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                f"Call {TOOL_NAME} exactly once with "
                                f"question='{scenario}'. Do not answer before "
                                "the tool result."
                            ),
                        }
                    ],
                }
            ],
        )
        deadline = time.monotonic() + 180
        for event in stream:
            observed.append(
                {
                    "type": event_type(event),
                    "id": getattr(event, "id", None),
                    "stop_reason": public(getattr(event, "stop_reason", None)),
                }
            )
            if is_requires_action(event):
                ids = get_event_ids(event)
                if not ids:
                    raise RuntimeError("requires_action without event_ids")
                return agent.id, session.id, ids[0], observed
            if time.monotonic() > deadline:
                raise TimeoutError("timed out waiting for requires_action")
    raise RuntimeError("stream ended before requires_action")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--cleanup-state",
        type=Path,
        help="Clean up resources recorded by an interrupted probe state file.",
    )
    args = parser.parse_args()

    client = anthropic.Anthropic()
    if args.cleanup_state is not None:
        cleanup_from_state(client, args.cleanup_state)
        return

    env_id: str | None = None
    created_agent_ids: list[str] = []
    created_session_ids: list[str] = []

    try:
        emit("state.path", str(STATE_PATH))
        env = client.beta.environments.create(
            name=f"oma-idempotency-probe-{RUN_ID}",
            config={"type": "cloud", "networking": {"type": "limited", "allowed_hosts": []}},
        )
        env_id = env.id
        write_state(
            STATE_PATH,
            env_id=env_id,
            agent_ids=created_agent_ids,
            session_ids=created_session_ids,
        )
        emit("environment.created", {"id": env_id, "model": MODEL})

        agent_id, session_id, tool_id, observed = create_requires_action_session(
            client,
            env_id,
            "no-key",
            created_agent_ids,
            created_session_ids,
            STATE_PATH,
        )
        emit("no_key.requires_action", {"session_id": session_id, "tool_id": tool_id, "observed": observed})
        no_key_first = send_result(client, session_id, tool_id, "NO_KEY_RESULT")
        no_key_first_id = response_event_id(no_key_first)
        if no_key_first_id is None:
            raise RuntimeError("no-key first result did not return an event id")
        no_key_before_duplicate = wait_for_end_turn(
            client,
            session_id,
            after_event_id=no_key_first_id,
        )
        no_key_duplicate = send_result(client, session_id, tool_id, "NO_KEY_RESULT")
        no_key_duplicate_id = response_event_id(no_key_duplicate)
        if no_key_duplicate_id is None:
            no_key_duplicate_settle_reason = "rejected"
            no_key_after_duplicate = list_events(client, session_id)
        else:
            no_key_duplicate_settle_reason, no_key_after_duplicate = (
                wait_for_duplicate_settled(
                    client,
                    session_id,
                    after_event_id=no_key_duplicate_id,
                )
            )
        emit("no_key.first_result", no_key_first)
        emit(
            "no_key.before_completed_turn_duplicate",
            {
                "event_count": len(no_key_before_duplicate),
                "agent_message_count": event_count(
                    no_key_before_duplicate, "agent.message"
                ),
                "custom_tool_result_count": event_count(
                    no_key_before_duplicate, "user.custom_tool_result"
                ),
            },
        )
        emit("no_key.duplicate_result", no_key_duplicate)
        emit(
            "no_key.after_completed_turn_duplicate",
            {
                "settle_reason": no_key_duplicate_settle_reason,
                "event_count": len(no_key_after_duplicate),
                "agent_message_count": event_count(
                    no_key_after_duplicate, "agent.message"
                ),
                "custom_tool_result_count": event_count(
                    no_key_after_duplicate, "user.custom_tool_result"
                ),
                "session_status_running_count": event_count(
                    no_key_after_duplicate, "session.status_running"
                ),
            },
        )
        emit(
            "no_key.events.list",
            no_key_after_duplicate,
        )

        agent_id, session_id, tool_id, observed = create_requires_action_session(
            client,
            env_id,
            "same-key",
            created_agent_ids,
            created_session_ids,
            STATE_PATH,
        )
        idem_key = f"oma-probe-{RUN_ID}-same-key"
        emit(
            "same_key.requires_action",
            {
                "session_id": session_id,
                "tool_id": tool_id,
                "idempotency_key": idem_key,
                "observed": observed,
            },
        )
        same_key_first = send_result(
            client,
            session_id,
            tool_id,
            "SAME_KEY_RESULT",
            idempotency_key=idem_key,
        )
        same_key_first_id = response_event_id(same_key_first)
        if same_key_first_id is None:
            raise RuntimeError("same-key first result did not return an event id")
        same_key_before_duplicate = wait_for_end_turn(
            client,
            session_id,
            after_event_id=same_key_first_id,
        )
        same_key_duplicate = send_result(
            client,
            session_id,
            tool_id,
            "SAME_KEY_RESULT",
            idempotency_key=idem_key,
        )
        same_key_duplicate_id = response_event_id(same_key_duplicate)
        if same_key_duplicate_id is None:
            same_key_duplicate_settle_reason = "rejected"
            same_key_after_duplicate = list_events(client, session_id)
        else:
            same_key_duplicate_settle_reason, same_key_after_duplicate = (
                wait_for_duplicate_settled(
                    client,
                    session_id,
                    after_event_id=same_key_duplicate_id,
                )
            )
        emit("same_key.first_result", same_key_first)
        emit(
            "same_key.before_completed_turn_duplicate",
            {
                "event_count": len(same_key_before_duplicate),
                "agent_message_count": event_count(
                    same_key_before_duplicate, "agent.message"
                ),
                "custom_tool_result_count": event_count(
                    same_key_before_duplicate, "user.custom_tool_result"
                ),
            },
        )
        emit("same_key.duplicate_result", same_key_duplicate)
        emit(
            "same_key.after_completed_turn_duplicate",
            {
                "settle_reason": same_key_duplicate_settle_reason,
                "event_count": len(same_key_after_duplicate),
                "agent_message_count": event_count(
                    same_key_after_duplicate, "agent.message"
                ),
                "custom_tool_result_count": event_count(
                    same_key_after_duplicate, "user.custom_tool_result"
                ),
                "session_status_running_count": event_count(
                    same_key_after_duplicate, "session.status_running"
                ),
            },
        )
        emit(
            "same_key.events.list",
            same_key_after_duplicate,
        )

        emit(
            "verdict",
            {
                "no_key_duplicate_ok": bool(no_key_duplicate.get("ok")),
                "no_key_duplicate_status": None
                if no_key_duplicate.get("ok")
                else no_key_duplicate.get("error", {}).get("status_code"),
                "same_key_duplicate_ok": bool(same_key_duplicate.get("ok")),
                "same_key_duplicate_status": None
                if same_key_duplicate.get("ok")
                else same_key_duplicate.get("error", {}).get("status_code"),
            },
        )
    finally:
        cleanup_ok = cleanup_resources(
            client,
            env_id=env_id,
            agent_ids=created_agent_ids,
            session_ids=created_session_ids,
        )
        if cleanup_ok:
            STATE_PATH.unlink(missing_ok=True)
        else:
            emit("cleanup.state_left_for_retry", str(STATE_PATH))


if __name__ == "__main__":
    main()
