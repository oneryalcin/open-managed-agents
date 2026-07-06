#!/usr/bin/env python3
"""Live probe 47: hosted Managed Agents MCP connector behavior (plan 0122 M1).

Questions this answers:
  1. Validation parity: does hosted reject dangling toolsets, unreferenced
     servers, duplicate mcp_toolsets per server (OMA tightening — open item
     in plan 0122 §4.1), and userinfo-embedded URLs?
  2. Exact wire frames for agent.mcp_tool_use / agent.mcp_tool_result on the
     allow path (evaluated_permission, bare vs namespaced tool name,
     correlation id semantics).
  3. Default-policy (always_ask) flow: requires_action shape for MCP,
     confirmation round-trip, result after allow.

Uses the public no-auth DeepWiki MCP server (https://mcp.deepwiki.com/mcp).

Requires:
  ANTHROPIC_API_KEY

Run:
  bash -c 'set -a; source <env-file>; set +a; \
    uv run --with anthropic python scratch/47-mcp-hosted-probe.py'
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

import anthropic

RUN_ID = uuid.uuid4().hex[:8]
MODEL = "claude-sonnet-5"
MCP_URL = "https://mcp.deepwiki.com/mcp"
PROMPT = (
    "Call the deepwiki MCP tool read_wiki_structure with repoName "
    "'badlogic/pi-mono'. Call it exactly once, then briefly say what "
    "top-level topics it returned."
)


def emit(kind: str, payload: Any) -> None:
    print(f"=== {kind} ===")
    print(json.dumps(payload, indent=2, default=str))


def public(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump()
    return value


def raw_events(client: anthropic.Anthropic, session_id: str) -> list[dict[str, Any]]:
    return [public(e) for e in client.beta.sessions.events.list(session_id, limit=100)]


def wait_for(client: anthropic.Anthropic, session_id: str, desc: str, pred, timeout_s: float = 240):
    deadline = time.monotonic() + timeout_s
    last: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        last = raw_events(client, session_id)
        if pred(last):
            return last
        time.sleep(2)
    raise TimeoutError(f"timed out waiting for {desc}; tail: {json.dumps(last[-3:], default=str)}")


def expect_rejection(client: anthropic.Anthropic, label: str, **kwargs) -> None:
    try:
        agent = client.beta.agents.create(**kwargs)
        emit(f"validation.{label}", {"UNEXPECTEDLY_ACCEPTED": True, "agent_id": agent.id})
        client.beta.agents.archive(agent.id)
    except anthropic.APIStatusError as error:
        emit(f"validation.{label}", {"status": error.status_code, "message": str(error)[:400]})


def validation_probes(client: anthropic.Anthropic) -> None:
    base = {"name": f"oma-probe47-val-{RUN_ID}", "model": MODEL}
    server = {"type": "url", "name": "deepwiki", "url": MCP_URL}
    toolset = {"type": "mcp_toolset", "mcp_server_name": "deepwiki"}

    expect_rejection(
        client, "dangling_toolset",
        **base, tools=[{"type": "agent_toolset_20260401"}, toolset],
    )
    expect_rejection(
        client, "unreferenced_server",
        **base, mcp_servers=[server], tools=[{"type": "agent_toolset_20260401"}],
    )
    # Plan 0122 §4.1 open item: OMA rejects two toolsets per server as a
    # tightening. What does hosted do?
    expect_rejection(
        client, "duplicate_toolset_per_server",
        **base, mcp_servers=[server],
        tools=[{"type": "agent_toolset_20260401"}, toolset, dict(toolset)],
    )
    expect_rejection(
        client, "userinfo_url",
        **base,
        mcp_servers=[{"type": "url", "name": "deepwiki", "url": "https://user:pass@mcp.deepwiki.com/mcp"}],
        tools=[{"type": "agent_toolset_20260401"}, toolset],
    )


def mcp_frames(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        e for e in events
        if str(e.get("type", "")) in (
            "agent.mcp_tool_use", "agent.mcp_tool_result", "session.error",
        )
        or (
            e.get("type") == "session.status_idle"
            and isinstance(e.get("stop_reason"), dict)
            and e["stop_reason"].get("type") == "requires_action"
        )
    ]


def scenario_allow(client: anthropic.Anthropic, env_id: str) -> None:
    agent = client.beta.agents.create(
        name=f"oma-probe47-allow-{RUN_ID}",
        model=MODEL,
        system="Use the deepwiki MCP tools when asked. Keep answers short.",
        mcp_servers=[{"type": "url", "name": "deepwiki", "url": MCP_URL}],
        tools=[
            {"type": "agent_toolset_20260401"},
            {
                "type": "mcp_toolset",
                "mcp_server_name": "deepwiki",
                "default_config": {"permission_policy": {"type": "always_allow"}},
            },
        ],
    )
    emit("allow.agent_created", {"id": agent.id, "mcp_servers": public(agent.mcp_servers)})
    session = client.beta.sessions.create(agent=agent.id, environment_id=env_id, title=f"oma-probe47-allow-{RUN_ID}")
    client.beta.sessions.events.send(session.id, events=[{"type": "user.message", "content": [{"type": "text", "text": PROMPT}]}])
    events = wait_for(
        client, session.id, "mcp_tool_result or terminal idle",
        lambda evts: any(e.get("type") == "agent.mcp_tool_result" for e in evts)
        or any(
            e.get("type") == "session.status_idle"
            and isinstance(e.get("stop_reason"), dict)
            and e["stop_reason"].get("type") == "end_turn"
            for e in evts
        ),
    )
    emit("allow.mcp_frames_raw", mcp_frames(events))
    cleanup(client, session.id, agent.id)


def scenario_default_ask(client: anthropic.Anthropic, env_id: str) -> None:
    agent = client.beta.agents.create(
        name=f"oma-probe47-ask-{RUN_ID}",
        model=MODEL,
        system="Use the deepwiki MCP tools when asked. Keep answers short.",
        mcp_servers=[{"type": "url", "name": "deepwiki", "url": MCP_URL}],
        tools=[
            {"type": "agent_toolset_20260401"},
            # No permission_policy: docs say the MCP toolset defaults to
            # always_ask — verify.
            {"type": "mcp_toolset", "mcp_server_name": "deepwiki"},
        ],
    )
    session = client.beta.sessions.create(agent=agent.id, environment_id=env_id, title=f"oma-probe47-ask-{RUN_ID}")
    client.beta.sessions.events.send(session.id, events=[{"type": "user.message", "content": [{"type": "text", "text": PROMPT}]}])
    events = wait_for(
        client, session.id, "requires_action for MCP",
        lambda evts: any(
            e.get("type") == "session.status_idle"
            and isinstance(e.get("stop_reason"), dict)
            and e["stop_reason"].get("type") == "requires_action"
            for e in evts
        ),
    )
    emit("ask.paused_mcp_frames_raw", mcp_frames(events))
    uses = [e for e in events if e.get("type") == "agent.mcp_tool_use"]
    if uses:
        client.beta.sessions.events.send(
            session.id,
            events=[{"type": "user.tool_confirmation", "tool_use_id": str(uses[-1]["id"]), "result": "allow"}],
        )
        events = wait_for(
            client, session.id, "mcp_tool_result after allow",
            lambda evts: any(e.get("type") == "agent.mcp_tool_result" for e in evts),
        )
        emit("ask.completed_mcp_frames_raw", mcp_frames(events))
    cleanup(client, session.id, agent.id)


def cleanup(client: anthropic.Anthropic, session_id: str, agent_id: str) -> None:
    try:
        wait_for(
            client, session_id, "terminal idle before cleanup",
            lambda evts: any(
                e.get("type") == "session.status_idle"
                and isinstance(e.get("stop_reason"), dict)
                and e["stop_reason"].get("type") == "end_turn"
                for e in evts
            ),
            timeout_s=120,
        )
    except TimeoutError:
        pass
    for op in (
        lambda: client.beta.sessions.delete(session_id),
        lambda: client.beta.agents.archive(agent_id),
    ):
        try:
            op()
        except anthropic.APIStatusError as error:
            emit("cleanup.warning", {"message": str(error)[:200]})


def main() -> None:
    client = anthropic.Anthropic()
    import os
    if os.environ.get("PROBE47_ONLY") != "ask":
        validation_probes(client)
    env = client.beta.environments.create(
        name=f"oma-probe47-{RUN_ID}",
        config={"type": "cloud", "networking": {"type": "unrestricted"}},
    )
    emit("environment.created", {"id": env.id})
    try:
        if os.environ.get("PROBE47_ONLY") != "ask":
            scenario_allow(client, env.id)
        scenario_default_ask(client, env.id)
    finally:
        client.beta.environments.delete(env.id)
    print("=== PROBE 47 COMPLETE ===")


if __name__ == "__main__":
    main()
