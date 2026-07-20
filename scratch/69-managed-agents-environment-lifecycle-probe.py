#!/usr/bin/env python3
"""Live CMA probe for environment archive/delete behavior required by OMA #206.

The probe creates two throwaway environments: one referenced by an idle session
to exercise archive/reference behavior, and one unreferenced environment to
exercise successful deletion. It prints redacted public responses only.

Requires:
  ANTHROPIC_API_KEY

Run:
  uv run --with anthropic python scratch/69-managed-agents-environment-lifecycle-probe.py
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Callable

import anthropic


MODEL = os.environ.get("OMA_ENVIRONMENT_LIFECYCLE_PROBE_MODEL", "claude-sonnet-4-6")
RUN_ID = f"{int(time.time())}-{os.getpid()}"
REQUEST_ID_RE = re.compile(r"req_[A-Za-z0-9]+")


def public(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [public(item) for item in value]
    if isinstance(value, dict):
        return {str(key): public(item) for key, item in value.items()}
    if hasattr(value, "model_dump"):
        return public(value.model_dump())
    if hasattr(value, "__dict__"):
        return public({key: item for key, item in vars(value).items() if not key.startswith("_")})
    return repr(value)


def redact(value: Any) -> Any:
    if isinstance(value, str):
        return REQUEST_ID_RE.sub("<redacted_request_id>", value)
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {
            str(key): "<redacted_request_id>" if key == "request_id" else redact(item)
            for key, item in value.items()
        }
    return value


def error_shape(error: BaseException) -> dict[str, Any]:
    return redact(
        {
            "type": type(error).__name__,
            "status_code": getattr(error, "status_code", None),
            "message": str(error)[:1000],
            "body": public(getattr(error, "body", None)),
        },
    )


def call(label: str, fn: Callable[[], Any]) -> dict[str, Any]:
    try:
        result = {"ok": True, "response": redact(public(fn()))}
    except Exception as error:  # noqa: BLE001
        result = {"ok": False, "error": error_shape(error)}
    print(f"## {label}")
    print(json.dumps(result, indent=2, sort_keys=True, default=str))
    return result


def create_environment(client: anthropic.Anthropic, label: str) -> Any:
    return client.beta.environments.create(
        name=f"oma-environment-lifecycle-{label}-{RUN_ID}",
        config={"type": "cloud", "networking": {"type": "unrestricted"}},
    )


def main() -> None:
    client = anthropic.Anthropic()
    referenced_environment_id: str | None = None
    disposable_environment_id: str | None = None
    active_referenced_environment_id: str | None = None
    agent_id: str | None = None
    session_id: str | None = None
    active_referenced_session_id: str | None = None
    try:
        referenced = create_environment(client, "referenced")
        referenced_environment_id = referenced.id
        call("environment.referenced.created", lambda: referenced)

        agent = client.beta.agents.create(
            name=f"oma-environment-lifecycle-agent-{RUN_ID}",
            model=MODEL,
            system="Reply briefly.",
        )
        agent_id = agent.id
        call("agent.created", lambda: agent)

        session = client.beta.sessions.create(
            agent=agent_id,
            environment_id=referenced_environment_id,
            title=f"oma-environment-lifecycle-session-{RUN_ID}",
        )
        session_id = session.id
        call("session.created.before_environment_archive", lambda: session)

        call(
            "environment.archive.referenced",
            lambda: client.beta.environments.archive(referenced_environment_id),
        )
        call(
            "environment.archive.referenced.repeated",
            lambda: client.beta.environments.archive(referenced_environment_id),
        )
        call(
            "environment.retrieve.after_archive",
            lambda: client.beta.environments.retrieve(referenced_environment_id),
        )
        call(
            "environment.list.default.after_archive",
            lambda: [
                {"id": env.id, "state": env.state, "archived_at": env.archived_at}
                for env in client.beta.environments.list(limit=100)
                if env.id == referenced_environment_id
            ],
        )
        call(
            "environment.list.include_archived.after_archive",
            lambda: [
                {"id": env.id, "state": env.state, "archived_at": env.archived_at}
                for env in client.beta.environments.list(limit=100, include_archived=True)
                if env.id == referenced_environment_id
            ],
        )
        call(
            "session.retrieve.after_environment_archive",
            lambda: client.beta.sessions.retrieve(session_id),
        )
        call(
            "session.create.with_archived_environment",
            lambda: client.beta.sessions.create(
                agent=agent_id,
                environment_id=referenced_environment_id,
                title=f"oma-environment-lifecycle-rejected-{RUN_ID}",
            ),
        )
        call(
            "environment.delete.referenced",
            lambda: client.beta.environments.delete(referenced_environment_id),
        )

        active_referenced = create_environment(client, "active-referenced")
        active_referenced_environment_id = active_referenced.id
        call("environment.active_referenced.created", lambda: active_referenced)
        active_referenced_session = client.beta.sessions.create(
            agent=agent_id,
            environment_id=active_referenced_environment_id,
            title=f"oma-environment-lifecycle-active-referenced-{RUN_ID}",
        )
        active_referenced_session_id = active_referenced_session.id
        call("session.created.before_active_environment_delete", lambda: active_referenced_session)
        call(
            "environment.delete.active_referenced",
            lambda: client.beta.environments.delete(active_referenced_environment_id),
        )
        call(
            "session.retrieve.after_active_environment_delete",
            lambda: client.beta.sessions.retrieve(active_referenced_session.id),
        )

        disposable = create_environment(client, "disposable")
        disposable_environment_id = disposable.id
        call("environment.disposable.created", lambda: disposable)
        call(
            "environment.delete.disposable",
            lambda: client.beta.environments.delete(disposable_environment_id),
        )
        call(
            "environment.retrieve.after_delete",
            lambda: client.beta.environments.retrieve(disposable_environment_id),
        )
    finally:
        if active_referenced_session_id:
            call(
                "cleanup.active_referenced_session.delete",
                lambda: client.beta.sessions.delete(active_referenced_session_id),
            )
        if session_id:
            call("cleanup.session.delete", lambda: client.beta.sessions.delete(session_id))
        if agent_id:
            call("cleanup.agent.archive", lambda: client.beta.agents.archive(agent_id))
        if disposable_environment_id:
            call(
                "cleanup.disposable_environment.delete",
                lambda: client.beta.environments.delete(disposable_environment_id),
            )
        if referenced_environment_id:
            call(
                "cleanup.referenced_environment.delete",
                lambda: client.beta.environments.delete(referenced_environment_id),
            )
        if active_referenced_environment_id:
            call(
                "cleanup.active_referenced_environment.delete",
                lambda: client.beta.environments.delete(active_referenced_environment_id),
            )


if __name__ == "__main__":
    main()
