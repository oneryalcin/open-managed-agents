#!/usr/bin/env python3
"""Live probe: Anthropic beta-header behavior for Managed Agents routes.

Requires:
  ANTHROPIC_API_KEY

Run:
  ANTHROPIC_API_KEY=... python scratch/31-managed-agents-beta-header-probe.py
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any


API_URL = "https://api.anthropic.com"
ANTHROPIC_VERSION = "2023-06-01"
MANAGED_AGENTS_BETA = "managed-agents-2026-04-01"
ENVIRONMENTS_BETA = "environments-2025-11-01"
REQUEST_ID_RE = re.compile(r"req_[A-Za-z0-9]+")

CASES = [
    ("/v1/agents", "missing", None),
    ("/v1/agents", "future_only", "future-beta"),
    ("/v1/agents", "env_only", ENVIRONMENTS_BETA),
    ("/v1/agents", "managed", MANAGED_AGENTS_BETA),
    ("/v1/agents", "managed_plus_future", f"{MANAGED_AGENTS_BETA}, future-beta"),
    ("/v1/sessions", "missing", None),
    ("/v1/sessions", "future_only", "future-beta"),
    ("/v1/sessions", "env_only", ENVIRONMENTS_BETA),
    ("/v1/sessions", "managed", MANAGED_AGENTS_BETA),
    ("/v1/sessions", "managed_plus_future", f"{MANAGED_AGENTS_BETA}, future-beta"),
    ("/v1/environments", "missing", None),
    ("/v1/environments", "env_beta", ENVIRONMENTS_BETA),
    ("/v1/environments", "managed", MANAGED_AGENTS_BETA),
    ("/v1/environments", "managed_plus_env", f"{MANAGED_AGENTS_BETA}, {ENVIRONMENTS_BETA}"),
    ("/v1/environments", "managed_plus_future", f"{MANAGED_AGENTS_BETA}, future-beta"),
    ("/v1/files", "missing", None),
    ("/v1/files", "files_guess", "files-api-2025-04-14"),
    ("/v1/files", "managed", MANAGED_AGENTS_BETA),
    ("/v1/files", "managed_plus_env", f"{MANAGED_AGENTS_BETA}, {ENVIRONMENTS_BETA}"),
    ("/v1/files", "managed_plus_future", f"{MANAGED_AGENTS_BETA}, future-beta"),
]


def redact(value: Any) -> Any:
    if isinstance(value, str):
        return REQUEST_ID_RE.sub("<redacted_request_id>", value)[:500]
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


def summarize_success(body: str) -> dict[str, Any]:
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return {"body": body[:500]}
    data = parsed.get("data") if isinstance(parsed, dict) else None
    return {
        "keys": sorted(parsed.keys()) if isinstance(parsed, dict) else [],
        "data_len": len(data) if isinstance(data, list) else None,
    }


def request(path: str, beta: str | None, api_key: str) -> dict[str, Any]:
    headers = {
        "x-api-key": api_key,
        "anthropic-version": ANTHROPIC_VERSION,
        "accept": "application/json",
    }
    if beta is not None:
        headers["anthropic-beta"] = beta
    req = urllib.request.Request(API_URL + path, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8", "replace")
            return {"status": resp.status, "body": summarize_success(body)}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = body[:500]
        return {"status": exc.code, "body": redact(parsed)}


def main() -> None:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise SystemExit("ANTHROPIC_API_KEY is required")

    results = []
    for path, label, beta in CASES:
        results.append({
            "path": path,
            "case": label,
            **request(path, beta, api_key),
        })
    print(json.dumps(results, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
