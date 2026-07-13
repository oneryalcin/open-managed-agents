#!/usr/bin/env python3
"""Probe 63 — hosted agent tool-config vocabulary and validation precedence.

Run:
  uv run --with anthropic python scratch/63-managed-agents-tool-config-validation-probe.py

The probe creates short-lived hosted agents and records only validation status,
error type/message, and response shape. Agent/environment/session identifiers
are deliberately not written to the artifact.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

import anthropic


API_KEY_ENV = Path("/Users/oner/dev/junk/cwc-workshops/.env")
MODEL = os.environ.get("OMA_TOOL_CONFIG_PROBE_MODEL", "claude-sonnet-5")
RUN_ID = uuid.uuid4().hex[:8]
ARTIFACT = Path(__file__).parent / "artifacts" / "63-managed-agents-tool-config-validation-probe.json"


def load_probe_key() -> str:
    for line in API_KEY_ENV.read_text().splitlines():
        if line.strip().startswith("ANTHROPIC_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit(f"ANTHROPIC_API_KEY not found in {API_KEY_ENV}")


def error_shape(exc: BaseException) -> dict[str, Any]:
    body = getattr(exc, "body", None)
    error = body.get("error") if isinstance(body, dict) else None
    return {
        "status_code": getattr(exc, "status_code", None),
        "error_type": error.get("type") if isinstance(error, dict) else None,
        "message": error.get("message") if isinstance(error, dict) else str(exc)[:500],
    }


def response_shape(agent: Any) -> dict[str, Any]:
    payload = agent.model_dump() if hasattr(agent, "model_dump") else {}
    tools = payload.get("tools") if isinstance(payload, dict) else None
    return {
        "keys": sorted(payload.keys()) if isinstance(payload, dict) else [],
        "tools": tools,
        "multiagent": payload.get("multiagent") if isinstance(payload, dict) else None,
    }


def base(label: str) -> dict[str, Any]:
    return {
        "name": f"oma-probe63-{label}-{RUN_ID}",
        "model": MODEL,
    }


def run_case(client: anthropic.Anthropic, label: str, body: dict[str, Any]) -> dict[str, Any]:
    agent_id: str | None = None
    try:
        agent = client.beta.agents.create(**body)
        agent_id = agent.id
        return {"accepted": True, "response": response_shape(agent)}
    except anthropic.APIStatusError as exc:
        return {"accepted": False, "error": error_shape(exc)}
    except Exception as exc:  # noqa: BLE001
        return {"accepted": False, "exception": {"type": type(exc).__name__, "message": str(exc)[:500]}}
    finally:
        if agent_id:
            try:
                client.beta.agents.archive(agent_id)
            except Exception:
                pass


def toolset(*, configs: list[dict[str, Any]] | None = None, default: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    value: dict[str, Any] = {"type": "agent_toolset_20260401"}
    if configs is not None:
        value["configs"] = configs
    if default is not None:
        value["default_config"] = default
    return [value]


def main() -> None:
    client = anthropic.Anthropic(api_key=load_probe_key())
    findings: dict[str, Any] = {
        "run_id": RUN_ID,
        "model": MODEL,
        "cases": {},
    }

    cases: list[tuple[str, dict[str, Any]]] = [
        ("baseline_no_tool_config", {**base("baseline"), "tools": toolset()}),
        (
            "unknown_tool_name",
            {**base("unknown-tool"), "tools": toolset(configs=[{"name": "oma_probe_unknown_tool", "enabled": False}])},
        ),
        (
            "unknown_default_permission_policy",
            {**base("unknown-default-policy"), "tools": toolset(default={"permission_policy": {"type": "oma_probe_unknown_policy"}})},
        ),
        (
            "unknown_config_permission_policy",
            {**base("unknown-config-policy"), "tools": toolset(configs=[{"name": "bash", "permission_policy": {"type": "oma_probe_unknown_policy"}}])},
        ),
        (
            "duplicate_config_same_name",
            {**base("duplicate-same"), "tools": toolset(configs=[{"name": "bash"}, {"name": "bash"}])},
        ),
        (
            "duplicate_config_conflicting_policy",
            {**base("duplicate-conflict"), "tools": toolset(configs=[
                {"name": "bash", "permission_policy": {"type": "always_allow"}},
                {"name": "bash", "permission_policy": {"type": "always_ask"}},
            ])},
        ),
        (
            "duplicate_toolset_entries",
            {**base("duplicate-toolset"), "tools": toolset() + toolset()},
        ),
        (
            "unknown_tool_and_unknown_policy",
            {**base("unknown-both"), "tools": toolset(configs=[{"name": "oma_probe_unknown_tool", "permission_policy": {"type": "oma_probe_unknown_policy"}}])},
        ),
        (
            "duplicate_and_unknown_policy",
            {**base("duplicate-unknown-policy"), "tools": toolset(configs=[
                {"name": "bash", "permission_policy": {"type": "oma_probe_unknown_policy"}},
                {"name": "bash"},
            ])},
        ),
        (
            "unknown_tool_and_malformed_default_policy",
            {**base("unknown-malformed-default"), "tools": toolset(
                configs=[{"name": "oma_probe_unknown_tool"}],
                default={"permission_policy": {"type": 42}},
            )},
        ),
        (
            "malformed_config_entry_and_unknown_default_policy",
            {**base("malformed-entry"), "tools": toolset(
                configs=[{"name": 42}],
                default={"permission_policy": {"type": "oma_probe_unknown_policy"}},
            )},
        ),
    ]

    for label, body in cases:
        findings["cases"][label] = run_case(client, label, body)

    known_candidates = ["bash", "read", "write", "edit", "glob", "grep", "web_fetch", "web_search", "find"]
    findings["candidate_tool_names"] = {
        name: run_case(
            client,
            f"candidate-{name}",
            {**base(f"candidate-{name}"), "tools": toolset(configs=[{"name": name, "enabled": False}])},
        )
        for name in known_candidates
    }

    policy_candidates = ["always_allow", "always_ask", "never_allow", "always_deny", "deny", "oma_probe_unknown_policy"]
    findings["permission_policy_candidates"] = {
        policy: run_case(
            client,
            f"policy-{policy}",
            {**base(f"policy-{policy}"), "tools": toolset(default={"permission_policy": {"type": policy}})},
        )
        for policy in policy_candidates
    }

    ARTIFACT.parent.mkdir(exist_ok=True)
    ARTIFACT.write_text(json.dumps(findings, indent=2, sort_keys=True))
    print(json.dumps(findings, indent=2, sort_keys=True))
    print(f"\nwrote {ARTIFACT}")


if __name__ == "__main__":
    main()
