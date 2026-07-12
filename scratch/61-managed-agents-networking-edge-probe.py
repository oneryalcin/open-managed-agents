#!/usr/bin/env python3
"""Probe hosted networking edge semantics before implementing OMA translation."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import anthropic


API = "https://api.anthropic.com"
BETA = "managed-agents-2026-04-01"
VERSION = "2023-06-01"
ENV_PATH = Path("/Users/oner/dev/junk/cwc-workshops/.env")
ARTIFACT = Path(__file__).parent / "artifacts" / "61-managed-agents-networking-edge-probe.json"
MODEL = os.environ.get("OMA_NETWORKING_PROBE_MODEL", "claude-sonnet-4-6")
RUN_ID = f"{int(time.time())}-{os.getpid()}"


def api_key() -> str:
    for line in ENV_PATH.read_text().splitlines():
        if line.strip().startswith("ANTHROPIC_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit(f"ANTHROPIC_API_KEY not found in {ENV_PATH}")


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


def request(method: str, path: str, body: Any | None = None) -> tuple[int, Any]:
    headers = {
        "x-api-key": api_key(),
        "anthropic-version": VERSION,
        "anthropic-beta": BETA,
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    req = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read()
            return response.status, json.loads(raw.decode() or "null")
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            parsed = json.loads(raw.decode() or "null")
        except Exception:
            parsed = raw.decode(errors="replace")
        return error.code, parsed


def create_agent(client: anthropic.Anthropic) -> str:
    agent = client.beta.agents.create(
        name=f"oma-networking-edge-agent-{RUN_ID}",
        model=MODEL,
        system="Use bash exactly once when asked, report every output line verbatim, and do not answer from memory.",
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


def run_network_session(
    client: anthropic.Anthropic,
    agent_id: str,
    environment_id: str,
    label: str,
    hosts: list[str],
) -> dict[str, Any]:
    session = client.beta.sessions.create(
        agent=agent_id,
        environment_id=environment_id,
        title=f"OMA networking edge {label} {RUN_ID}",
    )
    lines = " ".join(
        f"printf 'host={host} '; curl --silent --show-error --location --max-time 15 --output /dev/null --write-out 'http_code=%{{http_code}} exit_code=%{{exitcode}}\\n' 'https://{host}/' 2>&1 || true;"
        for host in hosts
    )
    result: dict[str, Any] = {"label": label, "session_id": session.id, "events": []}
    try:
        with client.beta.sessions.events.stream(session.id) as stream:
            client.beta.sessions.events.send(
                session.id,
                events=[
                    {
                        "type": "user.message",
                        "content": [
                            {
                                "type": "text",
                                "text": f"Use bash exactly once and run this exact command: {lines} Report the output lines verbatim.",
                            }
                        ],
                    }
                ],
            )
            deadline = time.monotonic() + 180
            for event in stream:
                event_type = str(getattr(event, "type", ""))
                if event_type == "agent.message":
                    blocks = getattr(event, "content", []) or []
                    result.setdefault("messages", []).append(
                        "".join(
                            str(getattr(block, "text", ""))
                            for block in blocks
                            if getattr(block, "type", "") == "text"
                        )
                    )
                result["events"].append(event_type)
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
    client = anthropic.Anthropic(api_key=api_key())
    agent_id: str | None = None
    environment_ids: list[str] = []
    session_ids: list[str] = []
    result: dict[str, Any] = {"run_id": RUN_ID, "model": MODEL}
    cases = {
        "empty_allowlist": {"type": "limited", "allowed_hosts": []},
        "wildcard": {"type": "limited", "allowed_hosts": ["*.example.com"]},
        "package_managers": {
            "type": "limited",
            "allowed_hosts": [],
            "allow_package_managers": True,
        },
        "mcp_servers": {
            "type": "limited",
            "allowed_hosts": [],
            "allow_mcp_servers": True,
        },
    }
    invalid_cases = {
        "url_in_allowed_hosts": {
            "type": "limited",
            "allowed_hosts": ["https://example.com"],
        },
        "port_in_allowed_hosts": {
            "type": "limited",
            "allowed_hosts": ["example.com:443"],
        },
        "uppercase_allowed_host": {
            "type": "limited",
            "allowed_hosts": ["EXAMPLE.COM"],
        },
    }
    try:
        result["create_cases"] = {}
        for label, networking in cases.items():
            status, body = request(
                "POST",
                "/v1/environments",
                {
                    "name": f"oma-networking-edge-{label}-{RUN_ID}",
                    "config": {"type": "cloud", "networking": networking},
                },
            )
            row: dict[str, Any] = {"status": status, "body": public(body)}
            if status == 200 and isinstance(body, dict) and body.get("id"):
                environment_id = str(body["id"])
                environment_ids.append(environment_id)
                row["id"] = environment_id
            result["create_cases"][label] = row

        result["invalid_cases"] = {}
        for label, networking in invalid_cases.items():
            status, body = request(
                "POST",
                "/v1/environments",
                {
                    "name": f"oma-networking-edge-invalid-{label}-{RUN_ID}",
                    "config": {"type": "cloud", "networking": networking},
                },
            )
            result["invalid_cases"][label] = {"status": status, "body": public(body)}

        agent_id = create_agent(client)
        host_checks = {
            "empty_allowlist": ["example.com"],
            "wildcard": ["example.com", "www.example.com"],
            "package_managers": ["pypi.org"],
            "mcp_servers": ["mcp.linear.app"],
        }
        result["runtime_cases"] = {}
        for label, hosts in host_checks.items():
            row = result["create_cases"].get(label, {})
            environment_id = row.get("id")
            if not environment_id:
                result["runtime_cases"][label] = {"skipped": "environment create failed"}
                continue
            probe = run_network_session(client, agent_id, environment_id, label, hosts)
            session_ids.append(str(probe["session_id"]))
            result["runtime_cases"][label] = probe
        print(json.dumps(result, indent=2, sort_keys=True))
    except Exception as exc:  # noqa: BLE001
        result["fatal_error"] = error_shape(exc)
        print(json.dumps(result, indent=2, sort_keys=True))
    finally:
        for session_id in session_ids:
            try:
                client.beta.sessions.delete(session_id)
            except Exception:
                pass
        if agent_id:
            try:
                client.beta.agents.archive(agent_id)
            except Exception:
                pass
        for environment_id in environment_ids:
            request("DELETE", f"/v1/environments/{environment_id}")
        ARTIFACT.write_text(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
