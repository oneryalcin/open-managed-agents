#!/usr/bin/env python3
"""Probe CMA limited-network wildcard depth and HTTP/HTTPS semantics."""

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
ARTIFACT = Path(__file__).parent / "artifacts" / "62-managed-agents-networking-depth-probe.json"


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


def create_agent(client: anthropic.Anthropic) -> str:
    agent = client.beta.agents.create(
        name=f"oma-networking-depth-agent-{RUN_ID}",
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
    client: anthropic.Anthropic, networking: dict[str, Any]
) -> str:
    environment = client.beta.environments.create(
        name=f"oma-networking-depth-{RUN_ID}",
        config={"type": "cloud", "networking": networking},
    )
    return environment.id


def run_probe_session(
    client: anthropic.Anthropic, agent_id: str, environment_id: str
) -> dict[str, Any]:
    session = client.beta.sessions.create(
        agent=agent_id,
        environment_id=environment_id,
        title=f"OMA networking depth {RUN_ID}",
    )
    targets = [
        ("https_nested", "https://a.b.1.1.1.1.nip.io/"),
        ("https_one_label", "https://www.1.1.1.1.nip.io/"),
        ("https_base", "https://nip.io/"),
        ("http_nested", "http://a.b.1.1.1.1.nip.io/"),
        ("http_one_label", "http://www.1.1.1.1.nip.io/"),
        ("http_base", "http://nip.io/"),
    ]
    commands = " ".join(
        "printf 'target=%s '; curl --silent --show-error --location --max-time 15 "
        "--output /dev/null --write-out 'http_code=%%{http_code} exit_code=%%{exitcode}\\n' "
        "'%s' 2>&1 || true;" % (label, url)
        for label, url in targets
    )
    prompt = (
        "Use bash exactly once and run this exact command, with no substitutions: "
        f"{commands} Report every output line verbatim."
    )
    result: dict[str, Any] = {"session_id": session.id, "events": []}
    try:
        with client.beta.sessions.events.stream(session.id) as stream:
            client.beta.sessions.events.send(
                session.id,
                events=[{"type": "user.message", "content": [{"type": "text", "text": prompt}]}],
            )
            deadline = time.monotonic() + 240
            for event in stream:
                event_type = str(getattr(event, "type", ""))
                result["events"].append(event_type)
                if event_type == "agent.message":
                    blocks = getattr(event, "content", []) or []
                    result.setdefault("messages", []).append(
                        "".join(
                            str(getattr(block, "text", ""))
                            for block in blocks
                            if getattr(block, "type", "") == "text"
                        )
                    )
                if event_type == "session.status_idle":
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
    environment_id: str | None = None
    session_id: str | None = None
    result: dict[str, Any] = {
        "run_id": RUN_ID,
        "model": MODEL,
        "networking": {"type": "limited", "allowed_hosts": ["*.nip.io"]},
    }
    try:
        agent_id = create_agent(client)
        environment_id = create_environment(
            client, {"type": "limited", "allowed_hosts": ["*.nip.io"]}
        )
        probe = run_probe_session(client, agent_id, environment_id)
        session_id = str(probe["session_id"])
        result["probe"] = probe
        print(json.dumps(result, indent=2, sort_keys=True))
    except Exception as exc:  # noqa: BLE001
        result["fatal_error"] = error_shape(exc)
        print(json.dumps(result, indent=2, sort_keys=True))
    finally:
        if session_id:
            try:
                client.beta.sessions.delete(session_id)
            except Exception:
                pass
        if agent_id:
            try:
                client.beta.agents.archive(agent_id)
            except Exception:
                pass
        if environment_id:
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
