#!/usr/bin/env python3
"""Hosted parity probe (0145 M2, web tools): web_fetch and web_search.

What events do they produce (agent.tool_use? a server-tool event?), what do
inputs and results look like, do permission policies apply (always_ask), and
how do usage.server_tool_use counts move?
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

import anthropic


MODEL = os.environ.get("OMA_WEB_PROBE_MODEL", "claude-sonnet-5")
RUN_ID = f"{int(time.time())}-{os.getpid()}"
# Run 1 (2026-10-09): no hosts. Run 2: OMA_WEB_PROBE_HOSTS=example.com,www.anthropic.com
HOSTS = [h for h in os.environ.get("OMA_WEB_PROBE_HOSTS", "").split(",") if h]


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


def clip(value: Any, limit: int = 600) -> Any:
    text = json.dumps(value, default=str)
    return value if len(text) <= limit else text[:limit] + "...<clipped>"


def events(client: anthropic.Anthropic, session_id: str) -> list[dict[str, Any]]:
    return [public(e) for e in client.beta.sessions.events.list(session_id)]


def wait_idle(client: anthropic.Anthropic, session_id: str, timeout: float) -> dict[str, Any] | None:
    deadline = time.monotonic() + timeout
    seen_running = False
    while time.monotonic() < deadline:
        status = str(client.beta.sessions.retrieve(session_id).status)
        seen_running = seen_running or status == "running"
        if seen_running and status == "idle":
            idles = [e for e in events(client, session_id) if e.get("type") == "session.status_idle"]
            return idles[-1] if idles else None
        time.sleep(1)
    return None


def summarize(evts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for e in evts:
        item = {k: e[k] for k in ("type", "name", "stop_reason") if k in e}
        for key in ("input", "content", "result", "server_tool_use", "error"):
            if key in e:
                item[key] = clip(e[key])
        extra = sorted(set(e) - {"id", "type", "processed_at", "name", "stop_reason", "input", "content", "result"})
        item["keys"] = extra
        out.append(item)
    return out


def scenario(client: anthropic.Anthropic, env_id: str, name: str, tools_cfg: list[dict[str, Any]], prompt: str) -> dict[str, Any]:
    agent = client.beta.agents.create(
        name=f"oma-web-{name}-{RUN_ID}",
        model=MODEL,
        system="Follow instructions literally.",
        tools=tools_cfg,
    )
    session = client.beta.sessions.create(agent=agent.id, environment_id=env_id, title=f"oma-web-{name}-{RUN_ID}")
    result: dict[str, Any] = {"agent_tools": clip(public(agent.tools), 1500)}
    try:
        client.beta.sessions.events.send(session.id, events=[{"type": "user.message", "content": [{"type": "text", "text": prompt}]}])
        last_idle = wait_idle(client, session.id, 240)
        result["last_idle"] = last_idle
        if last_idle and (last_idle.get("stop_reason") or {}).get("type") == "requires_action":
            pending = [e for e in events(client, session.id) if e.get("type") in ("agent.tool_use", "agent.server_tool_use") or "tool_use" in str(e.get("type"))]
            result["pending_before_confirm"] = summarize(pending[-2:])
            ids = (last_idle.get("stop_reason") or {}).get("event_ids") or []
            for event_id in ids:
                try:
                    client.beta.sessions.events.send(session.id, events=[{"type": "user.tool_confirmation", "tool_use_id": event_id, "result": "allow"}])
                except Exception as exc:  # noqa: BLE001
                    result.setdefault("confirm_errors", []).append(str(exc)[:400])
            result["after_confirm_idle"] = wait_idle(client, session.id, 240)
        result["events"] = summarize(events(client, session.id))
        result["usage"] = public(client.beta.sessions.retrieve(session.id).usage)
        return result
    finally:
        try:
            client.beta.sessions.events.send(session.id, events=[{"type": "user.interrupt"}])
        except Exception:
            pass
        time.sleep(2)
        try:
            client.beta.sessions.delete(session.id)
        except Exception:
            pass
        try:
            client.beta.agents.archive(agent.id)
        except Exception:
            pass


def main() -> None:
    client = anthropic.Anthropic()
    env = client.beta.environments.create(
        name=f"oma-web-env-{RUN_ID}",
        config={"type": "cloud", "networking": {"type": "limited", "allowed_hosts": HOSTS}},
    )
    findings: dict[str, Any] = {"run_id": RUN_ID, "model": MODEL, "allowed_hosts": HOSTS}
    try:
        only_web = lambda policy: [{  # noqa: E731
            "type": "agent_toolset_20260401",
            "default_config": {"enabled": False},
            "configs": [
                {"name": "web_fetch", "enabled": True, "permission_policy": {"type": policy}},
                {"name": "web_search", "enabled": True, "permission_policy": {"type": policy}},
            ],
        }]
        findings["fetch_allow"] = scenario(
            client, env.id, "fetch", only_web("always_allow"),
            "Use web_fetch exactly once on https://example.com and reply with the page's <h1> text only.",
        )
        findings["search_allow"] = scenario(
            client, env.id, "search", only_web("always_allow"),
            "Use web_search exactly once for: Anthropic Claude Managed Agents. Reply with the first result's title and URL only.",
        )
        findings["fetch_ask"] = scenario(
            client, env.id, "ask", only_web("always_ask"),
            "Use web_fetch exactly once on https://example.com and reply with the page's <h1> text only.",
        )
        print(json.dumps(findings, indent=2, sort_keys=True, default=str))
    finally:
        try:
            client.beta.environments.delete(env.id)
        except Exception:
            pass


if __name__ == "__main__":
    main()
