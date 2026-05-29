#!/usr/bin/env python3
"""Live probe: hosted Managed Agents builtin tool confirmation behavior.

Questions this answers for OMA #15/#38:
  - event shape when an always_ask builtin tool pauses
  - status_idle requires_action shape and event_ids source
  - user.tool_confirmation echo shape
  - allow vs deny continuation behavior

Requires:
  ANTHROPIC_API_KEY

Optional:
  OMA_TOOL_CONFIRMATION_PROBE_MODEL (default: claude-sonnet-4-6)

Run:
  ANTHROPIC_API_KEY=... uv run --with anthropic python scratch/32-managed-agents-tool-confirmation-probe.py
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Literal

import anthropic


MODEL = os.environ.get("OMA_TOOL_CONFIRMATION_PROBE_MODEL", "claude-sonnet-4-6")
RUN_ID = f"{int(time.time())}-{os.getpid()}"
REQUEST_ID_RE = re.compile(r"req_[A-Za-z0-9]+")
HOSTED_ID_RE = re.compile(
    r"\b(?:env|agent|sesn|sevt|sthr)_[A-Za-z0-9]+\b"
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


def redact(value: Any) -> Any:
    if isinstance(value, str):
        return HOSTED_ID_RE.sub(
            "<redacted_hosted_id>",
            REQUEST_ID_RE.sub("<redacted_request_id>", value),
        )
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {
            str(key): "<redacted_request_id>"
            if key == "request_id"
            else redact(val)
            for key, val in value.items()
        }
    return value


def emit(label: str, value: Any) -> None:
    print(f"## {label}")
    print(json.dumps(redact(public(value)), indent=2, sort_keys=True, default=str))


def error_shape(exc: BaseException) -> dict[str, Any]:
    return {
        "type": type(exc).__name__,
        "status_code": getattr(exc, "status_code", None),
        "message": redact(str(exc)[:1000]),
        "body": redact(public(getattr(exc, "body", None))),
    }


def event_type(event: Any) -> str:
    return str(getattr(event, "type", ""))


def is_requires_action(event: Any) -> bool:
    if event_type(event) != "session.status_idle":
        return False
    stop_reason = getattr(event, "stop_reason", None)
    return getattr(stop_reason, "type", None) == "requires_action"


def is_requires_action_compact(event: dict[str, Any]) -> bool:
    return (
        event.get("type") == "session.status_idle"
        and isinstance(event.get("stop_reason"), dict)
        and event["stop_reason"].get("type") == "requires_action"
    )


def is_final_idle_compact(event: dict[str, Any]) -> bool:
    return (
        event.get("type") == "session.status_idle"
        and isinstance(event.get("stop_reason"), dict)
        and event["stop_reason"].get("type") == "end_turn"
    )


def has_tool_result_and_later_final_idle(
    events: list[dict[str, Any]],
    tool_use_id: str,
) -> bool:
    result_index: int | None = None
    for index, event in enumerate(events):
        if (
            event.get("type") == "agent.tool_result"
            and event.get("tool_use_id") == tool_use_id
        ):
            result_index = index
    return result_index is not None and any(
        is_final_idle_compact(event)
        for event in events[result_index + 1 :]
    )


def compact_event(event: Any) -> dict[str, Any]:
    stop_reason = getattr(event, "stop_reason", None)
    return {
        "type": event_type(event),
        "id": getattr(event, "id", None),
        "name": getattr(event, "name", None),
        "input": public(getattr(event, "input", None)),
        "content_text": content_text(getattr(event, "content", None)),
        "tool_use_id": getattr(event, "tool_use_id", None),
        "result": getattr(event, "result", None),
        "processed_at": public(getattr(event, "processed_at", None)),
        "evaluated_permission": getattr(event, "evaluated_permission", None),
        "session_thread_id": getattr(event, "session_thread_id", None),
        "stop_reason": public(stop_reason),
        "is_error": getattr(event, "is_error", None),
    }


def content_text(content: Any) -> list[str]:
    value = public(content)
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for block in value:
        if not isinstance(block, dict):
            continue
        text = block.get("text")
        if isinstance(text, str):
            out.append(text)
    return out


def list_events(
    client: anthropic.Anthropic,
    session_id: str,
) -> list[dict[str, Any]]:
    return [
        compact_event(event)
        for event in client.beta.sessions.events.list(session_id, limit=100)
    ]


def wait_for_events(
    client: anthropic.Anthropic,
    session_id: str,
    desc: str,
    predicate: Any,
    timeout_s: float = 180,
) -> list[dict[str, Any]]:
    deadline = time.monotonic() + timeout_s
    last_events: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        last_events = list_events(client, session_id)
        if predicate(last_events):
            return last_events
        time.sleep(1)
    raise TimeoutError(f"timed out waiting for {desc}: {last_events[-5:]}")


def require_contract(
    result: Literal["allow", "deny"],
    observed: list[dict[str, Any]],
    listed: list[dict[str, Any]],
    marker: str,
    expected_command: str,
) -> None:
    contract_events = listed or observed
    ask_events = [
        event
        for event in contract_events
        if event.get("type") == "agent.tool_use"
        and event.get("evaluated_permission") == "ask"
        and isinstance(event.get("id"), str)
    ]
    if len(ask_events) != 1:
        raise RuntimeError(
            f"expected exactly one ask agent.tool_use, got {len(ask_events)}"
        )
    tool_use_id = str(ask_events[0]["id"])
    require_confirmable_input(ask_events[0], expected_command)

    requires_action_events = [
        event
        for event in contract_events
        if event.get("type") == "session.status_idle"
        and isinstance(event.get("stop_reason"), dict)
        and event["stop_reason"].get("type") == "requires_action"
    ]
    if not requires_action_events:
        raise RuntimeError("missing session.status_idle requires_action")
    if not any(
        event["stop_reason"].get("event_ids") == [tool_use_id]
        for event in requires_action_events
    ):
        raise RuntimeError(
            "requires_action.event_ids does not equal agent.tool_use id"
        )

    confirmations = [
        event
        for event in contract_events
        if event.get("type") == "user.tool_confirmation"
        and event.get("tool_use_id") == tool_use_id
        and event.get("result") == result
    ]
    if len(confirmations) != 1:
        raise RuntimeError(
            f"expected exactly one user.tool_confirmation, got {len(confirmations)}"
        )
    if confirmations[0].get("processed_at") is None:
        raise RuntimeError(
            "listed user.tool_confirmation did not have processed_at set"
        )

    tool_results = [
        event
        for event in contract_events
        if event.get("type") == "agent.tool_result"
        and event.get("tool_use_id") == tool_use_id
    ]
    if len(tool_results) != 1:
        raise RuntimeError(
            f"expected exactly one agent.tool_result, got {len(tool_results)}"
        )
    expected_error = result == "deny"
    if tool_results[0].get("is_error") is not expected_error:
        raise RuntimeError(
            f"agent.tool_result.is_error did not match {expected_error}"
        )
    tool_result_text = "\n".join(tool_results[0].get("content_text") or [])
    if result == "allow" and marker not in tool_result_text:
        raise RuntimeError("allowed tool result did not contain expected marker")
    if result == "deny" and marker in tool_result_text:
        raise RuntimeError("denied tool result unexpectedly contained marker")

    if not any(
        event.get("type") == "session.status_idle"
        and isinstance(event.get("stop_reason"), dict)
        and event["stop_reason"].get("type") == "end_turn"
        for event in contract_events
    ):
        raise RuntimeError("missing final session.status_idle end_turn")


def require_confirmable_input(
    ask_event: dict[str, Any],
    expected_command: str,
) -> None:
    if ask_event.get("name") != "bash":
        raise RuntimeError(
            f"expected confirmable tool name bash, got {ask_event.get('name')}"
        )
    input_value = ask_event.get("input")
    if not isinstance(input_value, dict):
        raise RuntimeError("confirmable agent.tool_use input is not an object")
    command = input_value.get("command")
    if not isinstance(command, str):
        raise RuntimeError("confirmable bash input is missing command")
    if command.strip() != expected_command:
        raise RuntimeError(
            f"confirmable bash command drifted: {command!r} != {expected_command!r}"
        )


def require_confirmation_response(
    response: Any,
    tool_use_id: str,
    result: Literal["allow", "deny"],
) -> None:
    value = public(response)
    data = value.get("data") if isinstance(value, dict) else None
    if not isinstance(data, list) or len(data) != 1:
        raise RuntimeError("confirmation response did not contain exactly one event")
    event = data[0]
    if not isinstance(event, dict):
        raise RuntimeError("confirmation response event is not an object")
    if event.get("type") != "user.tool_confirmation":
        raise RuntimeError(
            f"confirmation response type drifted: {event.get('type')}"
        )
    if event.get("tool_use_id") != tool_use_id:
        raise RuntimeError("confirmation response tool_use_id mismatch")
    if event.get("result") != result:
        raise RuntimeError("confirmation response result mismatch")
    if event.get("processed_at") is not None:
        raise RuntimeError("confirmation response processed_at was not null")


def find_confirmable_tool_id(
    events: list[dict[str, Any]],
    expected_command: str,
) -> str | None:
    for event in events:
        if (
            event.get("type") == "agent.tool_use"
            and event.get("evaluated_permission") == "ask"
        ):
            try:
                require_confirmable_input(event, expected_command)
            except RuntimeError:
                continue
            tool_use_id = event.get("id")
            if isinstance(tool_use_id, str):
                return tool_use_id
    return None


def verify_file_state_in_session(
    client: anthropic.Anthropic,
    session_id: str,
    path: str,
    expected: Literal["present", "absent"],
    marker: str,
    label: str,
) -> dict[str, Any]:
    command = f"if [ -f {path} ]; then cat {path}; else printf 'OMA_FILE_MISSING\\n'; fi"
    client.beta.sessions.events.send(
        session_id,
        events=[
            {
                "type": "user.message",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            "Use bash exactly once. Run this exact command: "
                            f"{command}."
                        ),
                    }
                ],
            }
        ],
    )
    events = wait_for_events(
        client,
        session_id,
        f"file verifier requires_action {label}",
        lambda listed: find_confirmable_tool_id(listed, command) is not None,
    )
    verifier_tool_use_id = find_confirmable_tool_id(events, command)
    if not verifier_tool_use_id:
        raise RuntimeError("file verifier did not produce confirmable bash use")
    confirmation_response = client.beta.sessions.events.send(
        session_id,
        events=[
            {
                "type": "user.tool_confirmation",
                "tool_use_id": verifier_tool_use_id,
                "result": "allow",
            }
        ],
    )
    require_confirmation_response(confirmation_response, verifier_tool_use_id, "allow")
    events = wait_for_events(
        client,
        session_id,
        f"file verifier result {label}",
        lambda listed: has_tool_result_and_later_final_idle(
            listed,
            verifier_tool_use_id,
        ),
    )
    tool_results = [
        event
        for event in events
        if event.get("type") == "agent.tool_result"
        and event.get("tool_use_id") == verifier_tool_use_id
    ]
    if not tool_results:
        raise RuntimeError("file verifier did not produce agent.tool_result")
    text = "\n".join(tool_results[-1].get("content_text") or [])
    present = marker in text
    missing = "OMA_FILE_MISSING" in text
    if expected == "present" and not present:
        raise RuntimeError(f"expected side-effect file to exist: {text!r}")
    if expected == "absent" and not missing:
        raise RuntimeError(f"expected side-effect file to be absent: {text!r}")
    return {
        "label": label,
        "expected": expected,
        "ok": True,
        "command": command,
        "tool_result_text": text,
    }


def verify_no_tool_result_before_confirmation(
    events: list[dict[str, Any]],
    pending_tool_use_id: str,
) -> None:
    if any(
        event.get("type") == "agent.tool_result"
        and event.get("tool_use_id") == pending_tool_use_id
        for event in events
    ):
        raise RuntimeError("tool result appeared before confirmation")


def run_confirmation_scenario(
    client: anthropic.Anthropic,
    env_id: str,
    result: Literal["allow", "deny"],
) -> dict[str, Any]:
    agent_id: str | None = None
    session_id: str | None = None
    observed: list[dict[str, Any]] = []
    confirmation_response: Any = None
    side_effect_checks: list[dict[str, Any]] = []

    try:
        agent = client.beta.agents.create(
            name=f"oma-tool-confirmation-{result}-{RUN_ID}",
            model=MODEL,
            system=(
                "When asked, use bash exactly once with the requested command. "
                "Do not answer from memory. After the tool either runs or is denied, "
                "briefly describe what happened."
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
        agent_id = agent.id

        session = client.beta.sessions.create(
            agent=agent_id,
            environment_id=env_id,
            title=f"oma-tool-confirmation-{result}-{RUN_ID}",
        )
        session_id = session.id

        pending_tool_use_id: str | None = None
        marker = f"OMA_TOOL_CONFIRMATION_{result.upper()}_{RUN_ID}"
        side_effect_path = f"/workspace/oma_tool_confirmation_{result}_{RUN_ID}.txt"
        expected_command = f"printf '{marker}\\n' | tee {side_effect_path}"
        client.beta.sessions.events.send(
            session_id,
            events=[
                {
                    "type": "user.message",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                "Use bash exactly once. Run this exact command: "
                                f"{expected_command}."
                            ),
                        }
                    ],
                }
            ],
        )

        observed = wait_for_events(
            client,
            session_id,
            "requires_action",
            lambda events: any(is_requires_action_compact(event) for event in events),
        )
        requires_action_events = [
            event for event in observed if is_requires_action_compact(event)
        ]
        event_ids = requires_action_events[-1]["stop_reason"].get("event_ids")
        if isinstance(event_ids, list) and event_ids:
            pending_tool_use_id = str(event_ids[0])
        if not pending_tool_use_id:
            raise RuntimeError("requires_action did not include pending tool id")
        pre_confirmation_ask_events = [
            event
            for event in observed
            if event.get("type") == "agent.tool_use"
            and event.get("evaluated_permission") == "ask"
            and event.get("id") == pending_tool_use_id
        ]
        if len(pre_confirmation_ask_events) != 1:
            raise RuntimeError("missing unique pre-confirmation ask agent.tool_use")
        require_confirmable_input(pre_confirmation_ask_events[0], expected_command)
        verify_no_tool_result_before_confirmation(observed, pending_tool_use_id)

        confirmation_response = client.beta.sessions.events.send(
            session_id,
            events=[
                {
                    "type": "user.tool_confirmation",
                    "tool_use_id": pending_tool_use_id,
                    "result": result,
                    **(
                        {"deny_message": "Denied by OMA probe."}
                        if result == "deny"
                        else {}
                    ),
                }
            ],
        )
        require_confirmation_response(
            confirmation_response,
            pending_tool_use_id,
            result,
        )
        compact_listed = wait_for_events(
            client,
            session_id,
            "post-confirmation end_turn",
            lambda events: any(
                event.get("type") == "agent.tool_result"
                and event.get("tool_use_id") == pending_tool_use_id
                for event in events
            )
            and any(is_final_idle_compact(event) for event in events),
        )
        require_contract(result, observed, compact_listed, marker, expected_command)
        side_effect_checks.append(
            verify_file_state_in_session(
                client,
                session_id,
                side_effect_path,
                "present" if result == "allow" else "absent",
                marker,
                f"{result}.after_confirmation",
            )
        )
        return {
            "ok": True,
            "result": result,
            "agent_id": agent_id,
            "session_id": session_id,
            "confirmation_response": public(confirmation_response),
            "side_effect_checks": side_effect_checks,
            "observed": observed,
            "listed": compact_listed,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "result": result,
            "agent_id": agent_id,
            "session_id": session_id,
            "error": error_shape(exc),
            "observed": observed,
        }
    finally:
        if session_id:
            try:
                client.beta.sessions.delete(session_id)
            except Exception as exc:  # noqa: BLE001
                emit(f"{result}.session.delete.cleanup.error", error_shape(exc))
        if agent_id:
            try:
                client.beta.agents.archive(agent_id)
            except Exception as exc:  # noqa: BLE001
                emit(f"{result}.agent.archive.cleanup.error", error_shape(exc))


def main() -> None:
    client = anthropic.Anthropic()
    created_env_id: str | None = None
    try:
        env = client.beta.environments.create(
            name=f"oma-tool-confirmation-probe-{RUN_ID}",
            config={"type": "cloud", "networking": {"type": "unrestricted"}},
        )
        created_env_id = env.id
        emit("environment.created", {"id": env.id})
        results = [
            run_confirmation_scenario(client, env.id, "deny"),
            run_confirmation_scenario(client, env.id, "allow"),
        ]
        emit("scenarios", results)
        emit(
            "verdict",
            {
                "all_ok": all(result["ok"] for result in results),
                "side_effect_checks_ok": [
                    all(
                        check.get("ok") is True
                        for check in result.get("side_effect_checks", [])
                    )
                    for result in results
                ],
                "requires_action_observed": [
                    any(
                        event.get("type") == "session.status_idle"
                        and public(event.get("stop_reason") or {}).get("type")
                        == "requires_action"
                        for event in result.get("observed", [])
                    )
                    for result in results
                ],
            },
        )
    finally:
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
