# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
"""Shared OMA SDK helpers for the dashboard and headless smoke."""

from __future__ import annotations

import io
import json
import os
import uuid
from pathlib import Path

import anthropic
from dotenv import load_dotenv

load_dotenv()

DATA = Path(__file__).parent / "data"
BASE_URL = os.environ.get("OMA_PROBE_BASE_URL", "http://127.0.0.1:40178")
BETA = os.environ.get("OMA_MANAGED_AGENTS_BETA", "managed-agents-2026-04-01")
MODEL = os.environ.get("OMA_SHIP_FIRST_PROBE_MODEL", "claude-sonnet-4-6")

SYSTEM = """\
You are the SRE Agent — an SRE/data-analyst agent embedded in an incident
dashboard. The application log is mounted at /mnt/session/uploads/app.log
(large; use grep/python to analyze it, don't read it whole). You have local
tools (get_metrics, get_recent_deploys, get_diff) that query the same data the
dashboard shows. Correlate evidence and state findings plainly and concisely.
"""

TOOLS = [
    {
        "type": "agent_toolset_20260401",
        "default_config": {
            "enabled": True,
            "permission_policy": {"type": "always_allow"},
        },
    },
    {
        "type": "custom",
        "name": "get_metrics",
        "description": "Timeseries for a service+metric over the incident window.",
        "input_schema": {
            "type": "object",
            "properties": {
                "service": {"type": "string"},
                "metric": {"type": "string"},
            },
            "required": ["service", "metric"],
        },
    },
    {
        "type": "custom",
        "name": "get_recent_deploys",
        "description": "Deploys in the last 6h.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "type": "custom",
        "name": "get_diff",
        "description": "Unified diff for a commit SHA.",
        "input_schema": {
            "type": "object",
            "properties": {"commit": {"type": "string"}},
            "required": ["commit"],
        },
    },
]

metrics = json.loads((DATA / "metrics.json").read_text())
deploys = (DATA / "deploys.json").read_text()
diff = (DATA / "diff.txt").read_text()

client = anthropic.Anthropic(
    api_key=os.environ.get("ANTHROPIC_API_KEY", "oma-local-dummy-key"),
    base_url=BASE_URL,
    default_headers={"anthropic-beta": BETA},
    max_retries=0,
    timeout=120,
)


def create_agent(name: str = "OMA SRE Agent") -> str:
    agent = client.beta.agents.create(
        name=name,
        model=MODEL,
        system=SYSTEM,
        tools=TOOLS,
    )
    return agent.id


def create_environment(name: str | None = None) -> str:
    env = client.beta.environments.create(
        name=name or f"oma-sre-agent-{uuid.uuid4().hex[:6]}",
        # This example does not need network access; OMA defaults to deny.
        config={"type": "cloud"},
    )
    return env.id


def upload_log() -> str:
    with open(DATA / "app.log", "rb") as file:
        uploaded = client.beta.files.upload(
            file=("app.log", io.BytesIO(file.read()), "text/plain"),
        )
    return uploaded.id


def start_session(agent_id: str, env_id: str, log_file_id: str) -> str:
    session = client.beta.sessions.create(
        agent=agent_id,
        environment_id=env_id,
        resources=[
            {"type": "file", "file_id": log_file_id, "mount_path": "app.log"},
        ],
    )
    return session.id


def stream_reply(session_id: str, user_text: str):
    with client.beta.sessions.events.stream(session_id) as stream:
        client.beta.sessions.events.send(
            session_id,
            events=[
                {
                    "type": "user.message",
                    "content": [{"type": "text", "text": user_text}],
                },
            ],
        )
        for ev in stream:
            if ev.type == "agent.custom_tool_use":
                result = handle_tool(ev.name, ev.input)
                client.beta.sessions.events.send(
                    session_id,
                    events=[
                        {
                            "type": "user.custom_tool_result",
                            "custom_tool_use_id": ev.id,
                            "content": [{"type": "text", "text": result}],
                        },
                    ],
                )
            yield ev


def handle_tool(name: str, args: dict) -> str:
    if name == "get_metrics":
        return json.dumps(
            metrics.get(args.get("service"), {}).get(args.get("metric"))
            or {"error": "not found"},
        )
    if name == "get_recent_deploys":
        return deploys
    if name == "get_diff":
        commit = str(args.get("commit", ""))
        return diff if commit[:7] in diff else "no diff for that commit"
    return f"unknown tool {name}"


def delete_session(session_id: str) -> None:
    client.beta.sessions.delete(session_id)
