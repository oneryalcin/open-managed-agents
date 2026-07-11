#!/usr/bin/env python3
"""Probe hosted session admission for bogus and deleted skill versions."""

from __future__ import annotations

import io
import json
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path
from typing import Any

API = "https://api.anthropic.com"
BETA = "managed-agents-2026-04-01,skills-2025-10-02"
ENV_PATH = Path("/Users/oner/dev/junk/cwc-workshops/.env")
RUN = uuid.uuid4().hex[:8]


def key() -> str:
    for line in ENV_PATH.read_text().splitlines():
        if line.strip().startswith("ANTHROPIC_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit("ANTHROPIC_API_KEY not found")


def request(method: str, path: str, body: Any = None, multipart: bytes | None = None, content_type: str | None = None):
    headers = {"x-api-key": key(), "anthropic-version": "2023-06-01", "anthropic-beta": BETA}
    data = multipart
    if body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    elif content_type:
        headers["content-type"] = content_type
    req = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            raw = response.read()
            return response.status, json.loads(raw or b"null")
    except urllib.error.HTTPError as error:
        raw = error.read()
        return error.code, json.loads(raw or b"null")


def create_skill():
    name = f"probe58-{RUN}"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(f"{name}/SKILL.md", f"---\nname: {name}\ndescription: dangling session probe\n---\n")
    boundary = f"----probe58{uuid.uuid4().hex}"
    payload = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"files[]\"; filename=\"skill.zip\"\r\nContent-Type: application/zip\r\n\r\n".encode() + buf.getvalue() + f"\r\n--{boundary}--\r\n".encode())
    return request("POST", "/v1/skills", multipart=payload, content_type=f"multipart/form-data; boundary={boundary}")


def main():
    out: dict[str, Any] = {"run": RUN}
    skill_id = agent_bogus = agent_latest = env_id = None
    try:
        status, skill = create_skill()
        skill_id = skill.get("id")
        version = skill.get("latest_version")
        out["create_skill"] = {"status": status, "id": skill_id, "version": version}
        status, env = request("POST", "/v1/environments", {"name": f"probe58-env-{RUN}", "config": {"type": "cloud", "networking": {"type": "unrestricted"}}})
        env_id = env.get("id")
        out["create_environment"] = {"status": status, "id": env_id}

        def agent(label: str, attached_version: str):
            return request("POST", "/v1/agents", {"name": f"probe58-{label}-{RUN}", "model": "claude-sonnet-4-6", "tools": [{"type": "agent_toolset_20260401"}], "skills": [{"type": "custom", "skill_id": skill_id, "version": attached_version}]})

        status, body = agent("bogus", "does-not-exist")
        agent_bogus = body.get("id") if isinstance(body, dict) else None
        out["attach_bogus_version"] = {"status": status, "body": body}
        if agent_bogus:
            status, body = request("POST", "/v1/sessions", {"agent": agent_bogus, "environment_id": env_id})
            out["session_bogus_version"] = {"status": status, "body": body}

        status, body = agent("latest", "latest")
        agent_latest = body.get("id") if isinstance(body, dict) else None
        out["attach_latest"] = {"status": status, "body": body}
        out["delete_attached_version"] = {"status": request("DELETE", f"/v1/skills/{skill_id}/versions/{version}")[0]}
        if agent_latest:
            status, body = request("POST", "/v1/sessions", {"agent": agent_latest, "environment_id": env_id})
            out["session_after_delete_last_version"] = {"status": status, "body": body}
    finally:
        for agent_id in (agent_bogus, agent_latest):
            if agent_id:
                request("POST", f"/v1/agents/{agent_id}/archive")
        if skill_id:
            request("DELETE", f"/v1/skills/{skill_id}")
        if env_id:
            request("DELETE", f"/v1/environments/{env_id}")
        artifact = Path(__file__).parent / "artifacts" / "58-skills-dangling-session-probe.json"
        artifact.write_text(json.dumps(out, indent=2))
        print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
