#!/usr/bin/env python3
"""Probe 53 — OAuth provider token-endpoint reality check with bogus tokens.

This probe does not use real OAuth grants. It sends syntactically plausible
bogus refresh-token requests to representative providers and records whether
the request format is accepted far enough to return OAuth-shaped errors.
"""

from __future__ import annotations

import base64
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any


RUN_ID = uuid.uuid4().hex[:10]
CLIENT_ID = f"probe53-client-{RUN_ID}"
CLIENT_SECRET = f"probe53-secret-{uuid.uuid4().hex}"
REFRESH_TOKEN = f"probe53-refresh-{uuid.uuid4().hex}"
REDACT_VALUES = {CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN}


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k.lower() in {"access_token", "refresh_token", "client_secret", "authorization"}:
                out[k] = "<redacted>"
            else:
                out[k] = redact(v)
        return out
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, str):
        redacted = value
        for secret in REDACT_VALUES:
            redacted = redacted.replace(secret, "<redacted-generated>")
        return redacted
    return value


def compact_body(value: Any) -> Any:
    value = redact(value)
    if isinstance(value, dict):
        return {k: compact_body(v) for k, v in value.items()}
    if isinstance(value, list):
        return [compact_body(v) for v in value[:5]]
    if isinstance(value, str):
        return value[:1000]
    return value


@dataclass
class HttpResult:
    status: int | None
    headers: dict[str, str]
    body: Any
    elapsed_ms: int
    error: str | None = None


def basic_header() -> str:
    raw = f"{urllib.parse.quote(CLIENT_ID, safe='')}:{urllib.parse.quote(CLIENT_SECRET, safe='')}"
    return "Basic " + base64.b64encode(raw.encode()).decode()


def post(url: str, *, mode: str, encoding: str) -> HttpResult:
    body_fields = {
        "grant_type": "refresh_token",
        "refresh_token": REFRESH_TOKEN,
    }
    headers = {"accept": "application/json", "user-agent": "oma-probe53/1"}
    if mode == "none":
        body_fields["client_id"] = CLIENT_ID
    elif mode == "client_secret_post":
        body_fields["client_id"] = CLIENT_ID
        body_fields["client_secret"] = CLIENT_SECRET
    elif mode == "client_secret_basic":
        headers["authorization"] = basic_header()
    else:
        raise ValueError(mode)

    if encoding == "form":
        data = urllib.parse.urlencode(body_fields).encode()
        headers["content-type"] = "application/x-www-form-urlencoded"
    elif encoding == "json":
        data = json.dumps(body_fields).encode()
        headers["content-type"] = "application/json"
    else:
        raise ValueError(encoding)

    req = urllib.request.Request(url, data=data, method="POST", headers=headers)
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read(65536)
            elapsed = int((time.monotonic() - start) * 1000)
            return HttpResult(res.status, dict(res.headers), parse(raw), elapsed)
    except urllib.error.HTTPError as err:
        raw = err.read(65536)
        elapsed = int((time.monotonic() - start) * 1000)
        return HttpResult(err.code, dict(err.headers), parse(raw), elapsed)
    except Exception as exc:
        elapsed = int((time.monotonic() - start) * 1000)
        return HttpResult(None, {}, None, elapsed, f"{type(exc).__name__}: {exc}")


def parse(raw: bytes) -> Any:
    text = raw.decode(errors="replace")
    try:
        return json.loads(text or "null")
    except Exception:
        return text[:2000]


def summarize(result: HttpResult) -> dict[str, Any]:
    return {
        "status": result.status,
        "elapsed_ms": result.elapsed_ms,
        "content_type": result.headers.get("Content-Type") or result.headers.get("content-type"),
        "retry_after": result.headers.get("Retry-After") or result.headers.get("retry-after"),
        "body": compact_body(result.body),
        "error": result.error,
    }


def main() -> None:
    cases = [
        {
            "name": "slack_form_basic",
            "provider": "slack",
            "url": "https://slack.com/api/oauth.v2.access",
            "mode": "client_secret_basic",
            "encoding": "form",
            "doc_note": "Slack docs list form/json content types, recommend Basic auth, and document grant_type=refresh_token.",
        },
        {
            "name": "slack_form_post",
            "provider": "slack",
            "url": "https://slack.com/api/oauth.v2.access",
            "mode": "client_secret_post",
            "encoding": "form",
            "doc_note": "Checks whether body client auth is accepted enough to return an OAuth-shaped error.",
        },
        {
            "name": "linear_form_basic",
            "provider": "linear",
            "url": "https://api.linear.app/oauth/token",
            "mode": "client_secret_basic",
            "encoding": "form",
            "doc_note": "Endpoint from Linear OAuth convention; live result is the evidence.",
        },
        {
            "name": "linear_form_post",
            "provider": "linear",
            "url": "https://api.linear.app/oauth/token",
            "mode": "client_secret_post",
            "encoding": "form",
            "doc_note": "Checks body client auth acceptance.",
        },
        {
            "name": "notion_json_basic",
            "provider": "notion",
            "url": "https://api.notion.com/v1/oauth/token",
            "mode": "client_secret_basic",
            "encoding": "json",
            "doc_note": "Notion docs show JSON body + Basic auth for refresh_token.",
        },
        {
            "name": "notion_form_basic",
            "provider": "notion",
            "url": "https://api.notion.com/v1/oauth/token",
            "mode": "client_secret_basic",
            "encoding": "form",
            "doc_note": "Checks whether OMA's planned form encoding would fail for Notion.",
        },
    ]
    findings = {"run_id": RUN_ID, "cases": {}}
    for case in cases:
        result = post(case["url"], mode=case["mode"], encoding=case["encoding"])
        findings["cases"][case["name"]] = {
            "provider": case["provider"],
            "url": case["url"],
            "mode": case["mode"],
            "encoding": case["encoding"],
            "doc_note": case["doc_note"],
            "result": summarize(result),
        }
    print(json.dumps(redact(findings), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
