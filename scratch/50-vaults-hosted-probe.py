#!/usr/bin/env python3
"""Probe 50 — hosted Managed Agents vaults/static_bearer behavior.

Run:
  python3 scratch/50-vaults-hosted-probe.py

Requires:
  ANTHROPIC_API_KEY

This script uses raw HTTPS so it does not depend on local Anthropic SDK
bindings. It records only response shapes/statuses and generated resource IDs;
it never prints the API key or the static bearer token value.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any


API = "https://api.anthropic.com"
BETA = "managed-agents-2026-04-01"
VERSION = "2023-06-01"
MODEL = os.environ.get("PROBE50_MODEL", "claude-sonnet-5")
LINEAR_MCP_URL = "https://mcp.linear.app/mcp"
TOKEN = f"probe50-token-{uuid.uuid4().hex}"
RUN_ID = uuid.uuid4().hex[:10]


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k.lower() in {"token", "access_token", "refresh_token", "client_secret"}:
                out[k] = "<redacted>"
            else:
                out[k] = redact(v)
        return out
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, str) and TOKEN in value:
        return value.replace(TOKEN, "<redacted-token>")
    return value


def shape(value: Any) -> Any:
    """Compact response shape: keys, scalar values where safe, no secrets."""
    value = redact(value)
    if isinstance(value, dict):
        result = {}
        for k, v in value.items():
            if k in {"id", "type", "archived_at", "mcp_server_name", "retry_status"}:
                result[k] = v
            elif k in {"display_name", "vault_id", "mcp_server_url"}:
                result[k] = v
            elif isinstance(v, (dict, list)):
                result[k] = shape(v)
            else:
                result[k] = type(v).__name__
        return result
    if isinstance(value, list):
        return [shape(v) for v in value[:5]]
    return value


@dataclass
class ApiResult:
    status: int
    body: Any
    headers: dict[str, str]


def request(method: str, path: str, body: Any | None = None, *, query: dict[str, Any] | None = None) -> ApiResult:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise SystemExit("ANTHROPIC_API_KEY required")

    url = API + path
    if query:
        url += "?" + urllib.parse.urlencode(query, doseq=True)
    data = None if body is None else json.dumps(body).encode()
    headers = {
        "x-api-key": api_key,
        "anthropic-version": VERSION,
        "anthropic-beta": BETA,
    }
    if body is not None:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read()
            parsed = json.loads(raw.decode() or "null") if raw else None
            return ApiResult(res.status, parsed, dict(res.headers))
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            parsed = json.loads(raw.decode() or "null") if raw else None
        except Exception:
            parsed = raw.decode(errors="replace")
        return ApiResult(err.code, parsed, dict(err.headers))


def emit(kind: str, payload: Any) -> None:
    print(f"=== {kind} ===")
    print(json.dumps(redact(payload), indent=2, sort_keys=True))


def cleanup_request(method: str, path: str, attempts: int = 3) -> ApiResult:
    last = request(method, path)
    for _ in range(attempts - 1):
        if last.status < 400:
            return last
        time.sleep(2)
        last = request(method, path)
    return last


def assert_status(result: ApiResult, expected: int, label: str) -> Any:
    if result.status != expected:
        emit(f"{label}.unexpected", {"status": result.status, "body": shape(result.body)})
        raise AssertionError(f"{label}: expected {expected}, got {result.status}")
    return result.body


def page_shape(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict):
        return {"body_type": type(body).__name__}
    return {
        "keys": sorted(body.keys()),
        "data_len": len(body.get("data", [])) if isinstance(body.get("data"), list) else None,
        "first": shape(body.get("data", [None])[0]) if body.get("data") else None,
        "has_next_page": body.get("has_next_page"),
        "next_page": body.get("next_page"),
    }


def wait_for_session_error(session_id: str, timeout_s: float = 180) -> dict[str, Any] | None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        events = request("GET", f"/v1/sessions/{session_id}/events", query={"limit": 100})
        if events.status != 200:
            emit("runtime.events_error", {"status": events.status, "body": shape(events.body)})
            return None
        data = events.body.get("data", []) if isinstance(events.body, dict) else []
        for event in data:
            if event.get("type") == "session.error":
                return event
        time.sleep(2)
    return None


def main() -> None:
    resources: dict[str, str] = {}
    sessions_to_cleanup: list[str] = []
    findings: dict[str, Any] = {"run_id": RUN_ID, "model": MODEL}
    try:
        vault = assert_status(
            request(
                "POST",
                "/v1/vaults",
                {"display_name": f"oma-probe50-{RUN_ID}", "metadata": {"probe": "50", "run": RUN_ID}},
            ),
            200,
            "vault.create",
        )
        resources["vault"] = vault["id"]
        findings["vault_create"] = shape(vault)

        listed = assert_status(request("GET", "/v1/vaults", query={"limit": 5}), 200, "vault.list")
        findings["vault_list"] = page_shape(listed)

        updated = assert_status(
            request("POST", f"/v1/vaults/{vault['id']}", {"display_name": f"oma-probe50-updated-{RUN_ID}"}),
            200,
            "vault.update",
        )
        findings["vault_update"] = shape(updated)

        cred_body = {
            "display_name": f"linear bogus {RUN_ID}",
            "metadata": {"probe": "50"},
            "auth": {
                "type": "static_bearer",
                "mcp_server_url": LINEAR_MCP_URL,
                "token": TOKEN,
            },
        }
        credential = assert_status(
            request("POST", f"/v1/vaults/{vault['id']}/credentials", cred_body),
            200,
            "credential.create",
        )
        resources["credential"] = credential["id"]
        findings["credential_create"] = shape(credential)
        findings["credential_create_raw_keys"] = sorted(credential.keys())
        findings["credential_auth_keys"] = sorted(credential.get("auth", {}).keys())
        findings["credential_secret_fields_absent"] = all(
            key not in json.dumps(credential) for key in ("probe50-token", TOKEN)
        )

        duplicate = request("POST", f"/v1/vaults/{vault['id']}/credentials", cred_body)
        findings["duplicate_active"] = {"status": duplicate.status, "body": shape(duplicate.body)}

        creds_list = assert_status(
            request("GET", f"/v1/vaults/{vault['id']}/credentials", query={"limit": 5}),
            200,
            "credential.list",
        )
        findings["credential_list"] = page_shape(creds_list)

        retrieved_cred = assert_status(
            request("GET", f"/v1/vaults/{vault['id']}/credentials/{credential['id']}"),
            200,
            "credential.retrieve",
        )
        findings["credential_retrieve"] = shape(retrieved_cred)

        immutable = request(
            "POST",
            f"/v1/vaults/{vault['id']}/credentials/{credential['id']}",
            {"auth": {"type": "static_bearer", "mcp_server_url": LINEAR_MCP_URL + "/", "token": TOKEN}},
        )
        findings["credential_immutable_update"] = {"status": immutable.status, "body": shape(immutable.body)}

        rotated = assert_status(
            request(
                "POST",
                f"/v1/vaults/{vault['id']}/credentials/{credential['id']}",
                {"auth": {"type": "static_bearer", "token": f"{TOKEN}-rotated"}},
            ),
            200,
            "credential.rotate",
        )
        findings["credential_rotate"] = shape(rotated)

        archived_cred = assert_status(
            request("POST", f"/v1/vaults/{vault['id']}/credentials/{credential['id']}/archive"),
            200,
            "credential.archive",
        )
        findings["credential_archive"] = shape(archived_cred)

        replacement = assert_status(
            request("POST", f"/v1/vaults/{vault['id']}/credentials", cred_body),
            200,
            "credential.replacement_after_archive",
        )
        resources["credential2"] = replacement["id"]
        findings["credential_replacement_after_archive"] = shape(replacement)

        agent = assert_status(
            request(
                "POST",
                "/v1/agents",
                {
                    "name": f"oma-probe50-agent-{RUN_ID}",
                    "model": MODEL,
                    "system": "Use the Linear MCP server if asked. Keep responses short.",
                    "mcp_servers": [{"type": "url", "name": "linear", "url": LINEAR_MCP_URL}],
                    "tools": [
                        {"type": "agent_toolset_20260401"},
                        {
                            "type": "mcp_toolset",
                            "mcp_server_name": "linear",
                            "default_config": {"permission_policy": {"type": "always_allow"}},
                        },
                    ],
                },
            ),
            200,
            "agent.create",
        )
        resources["agent"] = agent["id"]

        environment = assert_status(
            request(
                "POST",
                "/v1/environments",
                {
                    "name": f"oma-probe50-env-{RUN_ID}",
                    "config": {
                        "type": "cloud",
                        "networking": {
                            "type": "limited",
                            "allow_mcp_servers": True,
                            "allow_package_managers": False,
                            "allowed_hosts": [],
                        },
                    },
                },
            ),
            200,
            "environment.create",
        )
        resources["environment"] = environment["id"]
        findings["environment_create"] = {"id": environment["id"], "type": environment.get("type")}

        session = assert_status(
            request(
                "POST",
                "/v1/sessions",
                {
                    "agent": agent["id"],
                    "environment_id": environment["id"],
                    "vault_ids": [vault["id"]],
                    "title": f"oma-probe50-{RUN_ID}",
                },
            ),
            200,
            "session.create",
        )
        resources["session"] = session["id"]
        sessions_to_cleanup.append(session["id"])
        findings["session_create"] = {
            "id": session["id"],
            "vault_ids": session.get("vault_ids"),
            "keys": sorted(session.keys()),
        }

        send = request(
            "POST",
            f"/v1/sessions/{session['id']}/events",
            {
                "events": [
                    {
                        "type": "user.message",
                        "content": [
                            {
                                "type": "text",
                                "text": "Try to use the Linear MCP server once. If it fails, do not retry manually.",
                            }
                        ],
                    }
                ]
            },
        )
        findings["runtime_send"] = {"status": send.status, "body": shape(send.body)}
        if send.status == 200:
            err = wait_for_session_error(session["id"])
            findings["runtime_error_event"] = shape(err) if err else None

        unauth_session = assert_status(
            request(
                "POST",
                "/v1/sessions",
                {
                    "agent": agent["id"],
                    "environment_id": environment["id"],
                    "title": f"oma-probe50-unauth-{RUN_ID}",
                },
            ),
            200,
            "session.create_unauth",
        )
        sessions_to_cleanup.append(unauth_session["id"])
        findings["session_create_unauth"] = {
            "id": unauth_session["id"],
            "vault_ids": unauth_session.get("vault_ids"),
        }
        send_unauth = request(
            "POST",
            f"/v1/sessions/{unauth_session['id']}/events",
            {
                "events": [
                    {
                        "type": "user.message",
                        "content": [
                            {
                                "type": "text",
                                "text": "Try to use the Linear MCP server once. If it fails, do not retry manually.",
                            }
                        ],
                    }
                ]
            },
        )
        findings["runtime_send_unauth"] = {"status": send_unauth.status, "body": shape(send_unauth.body)}
        if send_unauth.status == 200:
            unauth_err = wait_for_session_error(unauth_session["id"])
            findings["runtime_error_event_unauth"] = shape(unauth_err) if unauth_err else None

        archived_vault = assert_status(
            request("POST", f"/v1/vaults/{vault['id']}/archive"),
            200,
            "vault.archive",
        )
        findings["vault_archive"] = shape(archived_vault)

        listed_archived = assert_status(
            request("GET", "/v1/vaults", query={"include_archived": "true", "limit": 5}),
            200,
            "vault.list_archived",
        )
        findings["vault_list_include_archived"] = page_shape(listed_archived)

    finally:
        cleanup = {}
        for session_id in sessions_to_cleanup:
            for kind, path in [
                (f"session_archive:{session_id}", f"/v1/sessions/{session_id}/archive"),
                (f"session:{session_id}", f"/v1/sessions/{session_id}"),
            ]:
                res = cleanup_request("POST" if "archive" in kind else "DELETE", path)
                cleanup[kind] = {"status": res.status, "body": shape(res.body)}
        for kind, path in [
            ("agent", f"/v1/agents/{resources.get('agent')}/archive"),
            ("environment_archive", f"/v1/environments/{resources.get('environment')}/archive"),
            ("environment", f"/v1/environments/{resources.get('environment')}"),
            ("vault", f"/v1/vaults/{resources.get('vault')}"),
        ]:
            if "None" in path:
                continue
            method = "DELETE" if kind in {"session", "environment", "vault"} else "POST"
            res = cleanup_request(method, path)
            cleanup[kind] = {"status": res.status, "body": shape(res.body)}
        findings["cleanup"] = cleanup

    emit("probe50.findings", findings)

    # Hard gates for M2 plan facts that should not be ambiguous.
    assert findings["credential_secret_fields_absent"] is True
    assert findings["duplicate_active"]["status"] == 409
    assert findings["credential_create"]["auth"]["type"] == "static_bearer"
    assert "token" not in findings["credential_auth_keys"]
    assert findings["session_create"]["vault_ids"] == [resources["vault"]]


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"PROBE50_FAIL: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise
