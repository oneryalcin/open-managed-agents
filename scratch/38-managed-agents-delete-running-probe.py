#!/usr/bin/env python3
"""Hosted parity probe: delete a running session and race delete vs interrupt."""

from __future__ import annotations

import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import anthropic


MODEL = os.environ.get("OMA_DELETE_RUNNING_PROBE_MODEL", "claude-sonnet-4-6")
RUN_ID = f"{int(time.time())}-{os.getpid()}"
MARKER = f"OMA_DELETE_RUNNING_PROBE_{RUN_ID}"


def public(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [public(item) for item in value]
    if isinstance(value, dict):
        return {str(key): public(val) for key, val in value.items()}
    if hasattr(value, "model_dump"):
        return public(value.model_dump())
    return repr(value)


def error_shape(exc: BaseException) -> dict[str, Any]:
    return {
        "exception": type(exc).__name__,
        "status_code": getattr(exc, "status_code", None),
        "message": str(exc)[:1000],
        "body": public(getattr(exc, "body", None)),
    }


def invoke(client: anthropic.Anthropic, operation: str, session_id: str) -> dict[str, Any]:
    try:
        result = (
            client.beta.sessions.delete(session_id)
            if operation == "delete"
            else client.beta.sessions.events.send(
                session_id,
                events=[{"type": "user.interrupt"}],
            )
        )
        return {"operation": operation, "ok": True, "response": public(result)}
    except Exception as exc:  # noqa: BLE001
        return {"operation": operation, "ok": False, "error": error_shape(exc)}


def wait_running(client: anthropic.Anthropic, session_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + 90
    statuses: list[str] = []
    while time.monotonic() < deadline:
        session = client.beta.sessions.retrieve(session_id)
        status = str(getattr(session, "status", ""))
        if status not in statuses:
            statuses.append(status)
        if status == "running":
            return {"status": status, "statuses": statuses}
        time.sleep(0.5)
    raise TimeoutError(f"session never became running: {statuses}")


def wait_not_running(client: anthropic.Anthropic, session_id: str) -> str:
    deadline = time.monotonic() + 30
    last_status = ""
    while time.monotonic() < deadline:
        last_status = str(getattr(client.beta.sessions.retrieve(session_id), "status", ""))
        if last_status != "running":
            return last_status
        time.sleep(0.5)
    return last_status


def create_agent_and_environment(client: anthropic.Anthropic) -> tuple[str, str]:
    env = client.beta.environments.create(
        name=f"oma-delete-running-env-{RUN_ID}",
        config={"type": "cloud", "networking": {"type": "unrestricted"}},
    )
    agent = client.beta.agents.create(
        name=f"oma-delete-running-agent-{RUN_ID}",
        model=MODEL,
        system="When asked, use bash exactly once. Do not answer from memory.",
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
    return agent.id, env.id


def start_long_turn(client: anthropic.Anthropic, session_id: str) -> None:
    client.beta.sessions.events.send(
        session_id,
        events=[
            {
                "type": "user.message",
                "content": [
                    {
                        "type": "text",
                        "text": f"Use bash exactly once and run: sleep 20; printf '{MARKER}\\n'. Do not answer from memory.",
                    }
                ],
            }
        ],
    )


def main() -> None:
    client = anthropic.Anthropic()
    agent_id: str | None = None
    env_id: str | None = None
    sessions: list[str] = []
    findings: dict[str, Any] = {"run_id": RUN_ID, "model": MODEL}
    try:
        agent_id, env_id = create_agent_and_environment(client)
        primary = client.beta.sessions.create(
            agent=agent_id,
            environment_id=env_id,
            title=f"oma-delete-running-primary-{RUN_ID}",
        )
        primary_id = primary.id
        sessions.append(primary_id)
        start_long_turn(client, primary_id)
        findings["primary_running"] = wait_running(client, primary_id)
        findings["primary_delete_while_running"] = invoke(client, "delete", primary_id)
        findings["primary_after_delete_attempt"] = public(client.beta.sessions.retrieve(primary_id))
        findings["primary_interrupt_after_delete_attempt"] = invoke(client, "interrupt", primary_id)

        race = client.beta.sessions.create(
            agent=agent_id,
            environment_id=env_id,
            title=f"oma-delete-running-race-{RUN_ID}",
        )
        race_id = race.id
        sessions.append(race_id)
        start_long_turn(client, race_id)
        findings["race_running"] = wait_running(client, race_id)
        with ThreadPoolExecutor(max_workers=2) as pool:
            delete_future = pool.submit(invoke, client, "delete", race_id)
            interrupt_future = pool.submit(invoke, client, "interrupt", race_id)
            findings["race_delete"] = delete_future.result()
            findings["race_interrupt"] = interrupt_future.result()
        findings["race_after"] = public(client.beta.sessions.retrieve(race_id))
        print(json.dumps(findings, indent=2, sort_keys=True, default=str))
    finally:
        for session_id in sessions:
            try:
                client.beta.sessions.delete(session_id)
            except Exception:
                try:
                    client.beta.sessions.events.send(
                        session_id,
                        events=[{"type": "user.interrupt"}],
                    )
                    wait_not_running(client, session_id)
                    client.beta.sessions.delete(session_id)
                except Exception:
                    pass
        if agent_id:
            try:
                client.beta.agents.archive(agent_id)
            except Exception:
                pass
        if env_id:
            try:
                client.beta.environments.delete(env_id)
            except Exception:
                pass


if __name__ == "__main__":
    main()
