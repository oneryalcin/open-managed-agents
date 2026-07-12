#!/usr/bin/env python3
"""Probe hosted Managed Agents environment networking semantics.

Run with the CWC credential:
  uv run --with anthropic python scratch/60-managed-agents-networking-probe.py

The probe compares an unrestricted environment with a limited environment
whose allowlist contains only ``example.com``. The agent runs curl against the
allowed host and a different host, so the artifact records the actual sandbox
egress result rather than inferring behavior from the accepted request shape.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import anthropic


API_KEY_ENV = Path("/Users/oner/dev/junk/cwc-workshops/.env")
MODEL = os.environ.get("OMA_NETWORKING_PROBE_MODEL", "claude-sonnet-4-6")
RUN_ID = f"{int(time.time())}-{os.getpid()}"
ARTIFACT = Path(__file__).parent / "artifacts" / "60-managed-agents-networking-probe.json"


def load_probe_key() -> str:
    for line in API_KEY_ENV.read_text().splitlines():
        if line.strip().startswith("ANTHROPIC_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit(f"ANTHROPIC_API_KEY not found in {API_KEY_ENV}")


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


def event_shape(event: Any) -> dict[str, Any]:
    event_type = str(getattr(event, "type", ""))
    result: dict[str, Any] = {"type": event_type}
    if event_type == "agent.message":
        blocks = getattr(event, "content", []) or []
        result["text"] = "".join(
            str(getattr(block, "text", ""))
            for block in blocks
            if getattr(block, "type", "") == "text"
        )
    elif event_type in {"agent.tool_use", "agent.tool_result", "user.tool_result"}:
        for field in ("name", "tool_use_id", "tool_name"):
            value = getattr(event, field, None)
            if value is not None:
                result[field] = str(value)
    elif event_type == "session.status_idle":
        stop_reason = getattr(event, "stop_reason", None)
        result["stop_reason"] = public(stop_reason)
    return result


def create_agent(client: anthropic.Anthropic) -> str:
    agent = client.beta.agents.create(
        name=f"oma-networking-probe-agent-{RUN_ID}",
        model=MODEL,
        system=(
            "When asked, use bash exactly once. Run the commands exactly as written, "
            "report every output line verbatim, and do not answer from memory."
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
    return agent.id


def create_environment(
    client: anthropic.Anthropic,
    label: str,
    networking: dict[str, Any],
) -> str:
    environment = client.beta.environments.create(
        name=f"oma-networking-probe-{label}-{RUN_ID}",
        config={"type": "cloud", "networking": networking},
    )
    return environment.id


def run_probe_session(
    client: anthropic.Anthropic,
    agent_id: str,
    environment_id: str,
    label: str,
) -> dict[str, Any]:
    session = client.beta.sessions.create(
        agent=agent_id,
        environment_id=environment_id,
        title=f"OMA networking probe {label} {RUN_ID}",
    )
    prompt = (
        "Use bash exactly once and run this exact command, with no substitutions: "
        "for host in example.com example.org; do "
        "printf 'host=%s ' \"$host\"; "
        "curl --silent --show-error --location --max-time 15 --output /dev/null "
        "--write-out 'http_code=%{http_code} exit_code=%{exitcode}\\n' \"https://$host/\" "
        "2>&1 || true; "
        "done. Report the two output lines verbatim."
    )
    result: dict[str, Any] = {"label": label, "session_id": session.id, "events": []}
    try:
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
                result["events"].append(event_shape(event))
                if getattr(event, "type", "") == "session.status_idle":
                    stop_reason = getattr(event, "stop_reason", None)
                    if getattr(stop_reason, "type", None) != "requires_action":
                        break
                if time.monotonic() > deadline:
                    raise TimeoutError("timed out waiting for terminal idle")
    except Exception as exc:  # noqa: BLE001
        result["error"] = error_shape(exc)
    return result


def main() -> None:
    client = anthropic.Anthropic(api_key=load_probe_key())
    agent_id: str | None = None
    environments: list[str] = []
    sessions: list[str] = []
    result: dict[str, Any] = {"run_id": RUN_ID, "model": MODEL}
    try:
        agent_id = create_agent(client)
        unrestricted_id = create_environment(
            client, "unrestricted", {"type": "unrestricted"}
        )
        limited_id = create_environment(
            client, "limited", {"type": "limited", "allowed_hosts": ["example.com"]}
        )
        environments.extend([unrestricted_id, limited_id])
        result["environment_requests"] = {
            "unrestricted": {"type": "unrestricted"},
            "limited": {"type": "limited", "allowed_hosts": ["example.com"]},
        }
        for label, environment_id in (
            ("unrestricted", unrestricted_id),
            ("limited", limited_id),
        ):
            probe = run_probe_session(client, agent_id, environment_id, label)
            sessions.append(str(probe["session_id"]))
            result[label] = probe
        print(json.dumps(result, indent=2, sort_keys=True))
    except Exception as exc:  # noqa: BLE001
        result["fatal_error"] = error_shape(exc)
        print(json.dumps(result, indent=2, sort_keys=True))
    finally:
        for session_id in sessions:
            try:
                client.beta.sessions.delete(session_id)
            except Exception:
                pass
        if agent_id:
            try:
                client.beta.agents.archive(agent_id)
            except Exception:
                pass
        for environment_id in environments:
            try:
                client.beta.environments.delete(environment_id)
            except Exception:
                try:
                    client.beta.environments.archive(environment_id)
                except Exception:
                    pass
        ARTIFACT.write_text(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
