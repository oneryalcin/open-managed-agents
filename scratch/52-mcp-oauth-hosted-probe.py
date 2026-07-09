#!/usr/bin/env python3
"""Probe 52 — hosted Managed Agents mcp_oauth vault wire shapes.

Run:
  python3 scratch/52-mcp-oauth-hosted-probe.py

Defaults to loading ANTHROPIC_API_KEY from:
  /Users/oner/dev/junk/cwc-workshops/.env

The script records only response shapes and generated resource IDs. Generated
dummy tokens/client secrets are redacted from all output.
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
from pathlib import Path
from typing import Any


API = "https://api.anthropic.com"
BETA = "managed-agents-2026-04-01"
VERSION = "2023-06-01"
ENV_PATH = Path("/Users/oner/dev/junk/cwc-workshops/.env")
LINEAR_MCP_URL = "https://mcp.linear.app/mcp"
RUN_ID = uuid.uuid4().hex[:10]

ACCESS = f"probe52-access-{uuid.uuid4().hex}"
ACCESS2 = f"probe52-access-rotated-{uuid.uuid4().hex}"
REFRESH = f"probe52-refresh-{uuid.uuid4().hex}"
REFRESH2 = f"probe52-refresh-rotated-{uuid.uuid4().hex}"
CLIENT_SECRET = f"probe52-client-secret-{uuid.uuid4().hex}"
STATIC_TOKEN = f"probe52-static-{uuid.uuid4().hex}"
REDACT_VALUES = {ACCESS, ACCESS2, REFRESH, REFRESH2, CLIENT_SECRET, STATIC_TOKEN}


def load_env_key() -> str:
    if not ENV_PATH.exists():
        raise SystemExit(f"missing env file: {ENV_PATH}")
    for line in ENV_PATH.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        if key.strip() == "ANTHROPIC_API_KEY":
            value = value.strip().strip("'").strip('"')
            if value:
                return value
    raise SystemExit(f"ANTHROPIC_API_KEY not found in {ENV_PATH}")


API_KEY = load_env_key()


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k.lower() in {
                "token",
                "access_token",
                "refresh_token",
                "client_secret",
                "authorization",
            }:
                out[k] = "<redacted>"
            else:
                out[k] = redact(v)
        return out
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, str):
        redacted = value
        for secret in REDACT_VALUES:
            redacted = redacted.replace(secret, f"<redacted:{secret.split('-', 2)[1]}>")
        return redacted
    return value


def shape(value: Any) -> Any:
    value = redact(value)
    if isinstance(value, dict):
        result = {}
        for k, v in value.items():
            if k in {
                "id",
                "type",
                "archived_at",
                "created_at",
                "updated_at",
                "display_name",
                "vault_id",
                "credential_id",
                "mcp_server_url",
                "status",
                "has_refresh_token",
                "validated_at",
                "method",
                "body_truncated",
                "message",
            }:
                result[k] = v
            elif k in {"status_code", "content_type", "body"}:
                result[k] = v if not isinstance(v, str) else v[:500]
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
    url = API + path
    if query:
        url += "?" + urllib.parse.urlencode(query, doseq=True)
    data = None if body is None else json.dumps(body).encode()
    headers = {
        "x-api-key": API_KEY,
        "anthropic-version": VERSION,
        "anthropic-beta": BETA,
    }
    if body is not None:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
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


def assert_status(result: ApiResult, expected: int, label: str) -> Any:
    if result.status != expected:
        emit(f"{label}.unexpected", {"status": result.status, "body": shape(result.body)})
        raise AssertionError(f"{label}: expected {expected}, got {result.status}")
    return result.body


def page_shape(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict):
        return {"body_type": type(body).__name__}
    first = None
    data = body.get("data")
    if isinstance(data, list) and data:
        first = shape(data[0])
    return {
        "keys": sorted(body.keys()),
        "data_len": len(data) if isinstance(data, list) else None,
        "first": first,
        "next_page": body.get("next_page"),
        "has_next_page": body.get("has_next_page"),
    }


def cleanup_request(method: str, path: str, attempts: int = 3) -> ApiResult:
    last = request(method, path)
    for _ in range(attempts - 1):
        if last.status < 400 or last.status == 404:
            return last
        time.sleep(1)
        last = request(method, path)
    return last


def validate(vault_id: str, credential_id: str) -> ApiResult:
    return request(
        "POST",
        f"/v1/vaults/{vault_id}/credentials/{credential_id}/mcp_oauth_validate",
        query={"beta": "true"},
    )


def oauth_auth(
    *,
    mcp_url: str = LINEAR_MCP_URL,
    access_token: str = ACCESS,
    refresh_token: str | None = None,
    token_endpoint: str = "https://slack.com/api/oauth.v2.access",
    client_id: str = "probe52-client",
    token_endpoint_auth: dict[str, Any] | None = None,
    expires_at: str | None = "2099-12-31T23:59:59Z",
) -> dict[str, Any]:
    auth: dict[str, Any] = {
        "type": "mcp_oauth",
        "mcp_server_url": mcp_url,
        "access_token": access_token,
    }
    if expires_at is not None:
        auth["expires_at"] = expires_at
    if refresh_token is not None:
        auth["refresh"] = {
            "token_endpoint": token_endpoint,
            "client_id": client_id,
            "scope": "probe:read",
            "refresh_token": refresh_token,
            "token_endpoint_auth": token_endpoint_auth
            if token_endpoint_auth is not None
            else {"type": "client_secret_post", "client_secret": CLIENT_SECRET},
        }
    return auth


def main() -> None:
    resources: dict[str, str] = {}
    findings: dict[str, Any] = {"run_id": RUN_ID, "env_key_source": str(ENV_PATH)}
    try:
        vault = assert_status(
            request(
                "POST",
                "/v1/vaults",
                {"display_name": f"oma-probe52-{RUN_ID}", "metadata": {"probe": "52", "run": RUN_ID}},
            ),
            200,
            "vault.create",
        )
        resources["vault"] = vault["id"]
        findings["vault_create"] = shape(vault)

        no_refresh = assert_status(
            request(
                "POST",
                f"/v1/vaults/{vault['id']}/credentials",
                {
                    "display_name": f"oauth no refresh {RUN_ID}",
                    "metadata": {"probe": "52", "case": "no_refresh"},
                    "auth": oauth_auth(),
                },
            ),
            200,
            "credential.create_no_refresh",
        )
        findings["oauth_no_refresh_create"] = shape(no_refresh)
        findings["oauth_no_refresh_auth_keys"] = sorted(no_refresh.get("auth", {}).keys())
        findings["oauth_no_refresh_secret_absent"] = not any(
            secret in json.dumps(no_refresh) for secret in REDACT_VALUES
        )
        no_refresh_validation = validate(vault["id"], no_refresh["id"])
        findings["validate_no_refresh"] = {
            "status": no_refresh_validation.status,
            "body": shape(no_refresh_validation.body),
        }
        findings["validate_no_refresh_raw_keys"] = (
            sorted(no_refresh_validation.body.keys()) if isinstance(no_refresh_validation.body, dict) else None
        )
        assert_status(
            request("POST", f"/v1/vaults/{vault['id']}/credentials/{no_refresh['id']}/archive"),
            200,
            "credential.archive_no_refresh",
        )

        expired_create = request(
            "POST",
            f"/v1/vaults/{vault['id']}/credentials",
            {
                "display_name": f"oauth expired {RUN_ID}",
                "metadata": {"probe": "52", "case": "expired"},
                "auth": oauth_auth(
                    mcp_url=f"{LINEAR_MCP_URL}?probe=expired-{RUN_ID}",
                    refresh_token=REFRESH,
                    expires_at="2000-01-01T00:00:00Z",
                ),
            },
        )
        findings["oauth_expired_create"] = {"status": expired_create.status, "body": shape(expired_create.body)}

        no_expires_no_refresh = request(
            "POST",
            f"/v1/vaults/{vault['id']}/credentials",
            {
                "display_name": f"oauth no expires no refresh {RUN_ID}",
                "metadata": {"probe": "52", "case": "no_expires_no_refresh"},
                "auth": oauth_auth(
                    mcp_url=f"{LINEAR_MCP_URL}?probe=no-exp-no-refresh-{RUN_ID}",
                    expires_at=None,
                ),
            },
        )
        findings["oauth_no_expires_no_refresh_create"] = {
            "status": no_expires_no_refresh.status,
            "body": shape(no_expires_no_refresh.body),
        }

        no_expires_with_refresh = request(
            "POST",
            f"/v1/vaults/{vault['id']}/credentials",
            {
                "display_name": f"oauth no expires refresh {RUN_ID}",
                "metadata": {"probe": "52", "case": "no_expires_with_refresh"},
                "auth": oauth_auth(
                    mcp_url=f"{LINEAR_MCP_URL}?probe=no-exp-refresh-{RUN_ID}",
                    refresh_token=REFRESH,
                    expires_at=None,
                ),
            },
        )
        findings["oauth_no_expires_with_refresh_create"] = {
            "status": no_expires_with_refresh.status,
            "body": shape(no_expires_with_refresh.body),
        }

        with_refresh = assert_status(
            request(
                "POST",
                f"/v1/vaults/{vault['id']}/credentials",
                {
                    "display_name": f"oauth refresh {RUN_ID}",
                    "metadata": {"probe": "52", "case": "with_refresh"},
                    "auth": oauth_auth(refresh_token=REFRESH, expires_at="2099-12-31T23:59:59Z"),
                },
            ),
            200,
            "credential.create_with_refresh",
        )
        resources["with_refresh_credential"] = with_refresh["id"]
        findings["oauth_with_refresh_create"] = shape(with_refresh)
        findings["oauth_with_refresh_auth_keys"] = sorted(with_refresh.get("auth", {}).keys())
        findings["oauth_with_refresh_refresh_keys"] = sorted(with_refresh.get("auth", {}).get("refresh", {}).keys())
        findings["oauth_with_refresh_secret_absent"] = not any(
            secret in json.dumps(with_refresh) for secret in REDACT_VALUES
        )

        retrieved = assert_status(
            request("GET", f"/v1/vaults/{vault['id']}/credentials/{with_refresh['id']}"),
            200,
            "credential.retrieve_with_refresh",
        )
        findings["oauth_retrieve"] = shape(retrieved)

        listed = assert_status(
            request("GET", f"/v1/vaults/{vault['id']}/credentials", query={"limit": 10, "include_archived": "true"}),
            200,
            "credential.list",
        )
        findings["oauth_list"] = page_shape(listed)

        rotated = request(
            "POST",
            f"/v1/vaults/{vault['id']}/credentials/{with_refresh['id']}",
            {
                "auth": {
                    "type": "mcp_oauth",
                    "access_token": ACCESS2,
                    "expires_at": "2099-12-31T23:59:59Z",
                    "refresh": {"refresh_token": REFRESH2},
                }
            },
        )
        findings["oauth_update_merge"] = {"status": rotated.status, "body": shape(rotated.body)}

        token_endpoint_immutable = request(
            "POST",
            f"/v1/vaults/{vault['id']}/credentials/{with_refresh['id']}",
            {
                "auth": {
                    "type": "mcp_oauth",
                    "access_token": ACCESS2,
                    "expires_at": "2099-12-31T23:59:59Z",
                    "refresh": {
                        "token_endpoint": "https://example.com/oauth/token",
                        "refresh_token": REFRESH2,
                    },
                }
            },
        )
        findings["immutable_token_endpoint"] = {
            "status": token_endpoint_immutable.status,
            "body": shape(token_endpoint_immutable.body),
        }

        client_id_immutable = request(
            "POST",
            f"/v1/vaults/{vault['id']}/credentials/{with_refresh['id']}",
            {
                "auth": {
                    "type": "mcp_oauth",
                    "access_token": ACCESS2,
                    "expires_at": "2099-12-31T23:59:59Z",
                    "refresh": {"client_id": "changed-client", "refresh_token": REFRESH2},
                }
            },
        )
        findings["immutable_client_id"] = {
            "status": client_id_immutable.status,
            "body": shape(client_id_immutable.body),
        }

        with_refresh_validation = validate(vault["id"], with_refresh["id"])
        findings["validate_with_refresh"] = {
            "status": with_refresh_validation.status,
            "body": shape(with_refresh_validation.body),
        }

        assert_status(
            request("POST", f"/v1/vaults/{vault['id']}/credentials/{with_refresh['id']}/archive"),
            200,
            "credential.archive_with_refresh",
        )
        archived_validation = validate(vault["id"], with_refresh["id"])
        findings["validate_archived_oauth"] = {
            "status": archived_validation.status,
            "body": shape(archived_validation.body),
        }

        reflective = request(
            "POST",
            f"/v1/vaults/{vault['id']}/credentials",
            {
                "display_name": f"oauth reflective {RUN_ID}",
                "metadata": {"probe": "52", "case": "reflective"},
                "auth": oauth_auth(
                    refresh_token=REFRESH,
                    token_endpoint="https://postman-echo.com/post",
                    token_endpoint_auth={"type": "none"},
                    expires_at="2099-12-31T23:59:59Z",
                ),
            },
        )
        findings["reflective_refresh_create"] = {"status": reflective.status, "body": shape(reflective.body)}
        if reflective.status == 200 and isinstance(reflective.body, dict):
            resources["reflective_credential"] = reflective.body["id"]
            reflective_validation = validate(vault["id"], reflective.body["id"])
            findings["validate_reflective_refresh"] = {
                "status": reflective_validation.status,
                "body": shape(reflective_validation.body),
                "raw_body_contains_generated_secret": any(
                    secret in json.dumps(reflective_validation.body) for secret in REDACT_VALUES
                ),
            }
            request("POST", f"/v1/vaults/{vault['id']}/credentials/{reflective.body['id']}/archive")

        static = assert_status(
            request(
                "POST",
                f"/v1/vaults/{vault['id']}/credentials",
                {
                    "display_name": f"static validate {RUN_ID}",
                    "auth": {
                        "type": "static_bearer",
                        "mcp_server_url": "https://example.com/mcp",
                        "token": STATIC_TOKEN,
                    },
                },
            ),
            200,
            "credential.create_static",
        )
        static_validation = validate(vault["id"], static["id"])
        findings["validate_static_bearer"] = {
            "status": static_validation.status,
            "body": shape(static_validation.body),
        }

    finally:
        cleanup: dict[str, Any] = {}
        for kind, path, method in [
            ("vault_archive", f"/v1/vaults/{resources.get('vault')}/archive", "POST"),
            ("vault_delete", f"/v1/vaults/{resources.get('vault')}", "DELETE"),
        ]:
            if "None" in path:
                continue
            res = cleanup_request(method, path)
            cleanup[kind] = {"status": res.status, "body": shape(res.body)}
        findings["cleanup"] = cleanup

    emit("probe52.findings", findings)

    assert findings["oauth_no_refresh_secret_absent"] is True
    assert findings["oauth_with_refresh_secret_absent"] is True


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"PROBE52_FAIL: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise
