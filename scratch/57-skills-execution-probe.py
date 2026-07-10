#!/usr/bin/env python3
"""Probe 57 — hosted Managed Agents skill EXECUTION trace.

Run:
  python3 scratch/57-skills-execution-probe.py

Closes the runtime unknowns for plan 0126:
  1. Do skills surface as ordinary events (no skill.* event type)?  -> collect
     the distinct event `type` set from a real run.
  2. What sandbox path are skill files mounted at?  -> a custom skill instructs
     the model to `pwd` + print this SKILL.md's absolute path via bash; we read
     it back out of the tool_result events.
  3. Read-tool coupling: session create with agent_with_overrides clearing
     tools while skills are attached -> expect 400 (agent-create did NOT
     enforce it per probe 56).

Loads ANTHROPIC_API_KEY from /Users/oner/dev/junk/cwc-workshops/.env.
"""

from __future__ import annotations

import io
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path
from typing import Any

API = "https://api.anthropic.com"
VERSION = "2023-06-01"
BETA = "managed-agents-2026-04-01,skills-2025-10-02"
ENV_PATH = Path("/Users/oner/dev/junk/cwc-workshops/.env")
RUN = uuid.uuid4().hex[:8]
SKILL_NAME = f"probe57-{RUN}"
MODEL = "claude-sonnet-4-6"
POLL_BUDGET_S = 120


def load_env_key() -> str:
    for line in ENV_PATH.read_text().splitlines():
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            k, v = s.split("=", 1)
            if k.strip() == "ANTHROPIC_API_KEY":
                return v.strip().strip("'").strip('"')
    raise SystemExit("ANTHROPIC_API_KEY not found")


API_KEY = load_env_key()


def request(method: str, path: str, *, body: Any = None, multipart: bytes | None = None,
            content_type: str | None = None, query: dict[str, Any] | None = None) -> tuple[int, Any]:
    url = API + path + ("?" + urllib.parse.urlencode(query, doseq=True) if query else "")
    headers = {"x-api-key": API_KEY, "anthropic-version": VERSION, "anthropic-beta": BETA}
    data = None
    if multipart is not None:
        data, headers["content-type"] = multipart, content_type or "application/octet-stream"
    elif body is not None:
        data, headers["content-type"] = json.dumps(body).encode(), "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            raw = res.read()
            return res.status, (json.loads(raw.decode() or "null") if raw else None)
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, (json.loads(raw.decode() or "null") if raw else None)
        except Exception:
            return err.code, raw.decode(errors="replace")[:500]


def make_skill_zip(name: str) -> bytes:
    skill_md = (
        f"---\nname: {name}\n"
        "description: Diagnostic probe skill. Use this whenever the user says 'run the probe skill'.\n"
        "---\n\n# Probe skill\n\n"
        "When invoked, use the bash tool to run exactly:\n\n"
        "```\npwd && ls -la ~/.skills 2>/dev/null; readlink -f \"$0\" 2>/dev/null; "
        "find / -name SKILL.md 2>/dev/null | grep -i probe57 | head -1\n```\n\n"
        "Then reply with a single line: `PROBE57_MOUNT=<the SKILL.md absolute path you found>`.\n"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{name}/SKILL.md", skill_md)
    return buf.getvalue()


def multipart(files: list[tuple[str, str, bytes]]) -> tuple[bytes, str]:
    boundary = f"----probe57{uuid.uuid4().hex}"
    out = io.BytesIO()
    for field, filename, content in files:
        out.write(f"--{boundary}\r\n".encode())
        out.write(f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'.encode())
        out.write(b"Content-Type: application/zip\r\n\r\n")
        out.write(content + b"\r\n")
    out.write(f"--{boundary}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={boundary}"


def main() -> None:
    findings: dict[str, Any] = {"run": RUN}
    skill_id = env_id = agent_id = session_id = None
    versions: list[str] = []
    try:
        # Skill
        data, ctype = multipart([("files[]", f"{SKILL_NAME}.zip", make_skill_zip(SKILL_NAME))])
        st, body = request("POST", "/v1/skills", multipart=data, content_type=ctype)
        skill_id = body.get("id") if isinstance(body, dict) else None
        if isinstance(body, dict) and body.get("latest_version"):
            versions.append(body["latest_version"])
        findings["create_skill"] = {"status": st, "id": skill_id}

        # Environment (cloud)
        st, body = request("POST", "/v1/environments", body={
            "name": f"probe57-env-{RUN}",
            "config": {"type": "cloud", "networking": {"type": "unrestricted"}},
        })
        env_id = body.get("id") if isinstance(body, dict) else None
        findings["create_environment"] = {"status": st, "id": env_id}

        # Agent with the custom skill + prebuilt toolset (provides read/bash)
        st, body = request("POST", "/v1/agents", body={
            "name": f"probe57-agent-{RUN}", "model": MODEL,
            "tools": [{"type": "agent_toolset_20260401"}],
            "skills": [{"type": "custom", "skill_id": skill_id}],
        })
        agent_id = body.get("id") if isinstance(body, dict) else None
        findings["create_agent"] = {"status": st, "id": agent_id, "skills_echo": body.get("skills") if isinstance(body, dict) else None}

        # Coupling test: session with overrides clearing tools while skills present
        st, body = request("POST", "/v1/sessions", body={
            "agent": {"type": "agent_with_overrides", "id": agent_id, "tools": []},
            "environment_id": env_id,
        })
        findings["session_tools_cleared_with_skills"] = {"status": st,
            "error": body.get("error") if isinstance(body, dict) else body}
        if st == 200 and isinstance(body, dict):  # unexpected success -> clean it
            request("POST", f"/v1/sessions/{body.get('id')}/archive")

        # Real session
        st, body = request("POST", "/v1/sessions", body={"agent": agent_id, "environment_id": env_id,
                                                          "title": f"probe57-{RUN}"})
        session_id = body.get("id") if isinstance(body, dict) else None
        findings["create_session"] = {"status": st, "id": session_id}
        if not session_id:
            findings["create_session"]["body"] = body
            raise SystemExit("no session")

        # Kick off: user message that triggers the skill
        st, _ = request("POST", f"/v1/sessions/{session_id}/events", body={
            "events": [{"type": "user.message", "content": [{"type": "text",
                "text": "Run the probe skill now and report the mount path."}]}]})
        findings["send_user_message"] = {"status": st}

        # Poll events until terminal or budget
        seen_types: dict[str, int] = {}
        mount_line = None
        skill_events: list[str] = []
        deadline = time.monotonic() + POLL_BUDGET_S
        terminal = False
        while time.monotonic() < deadline and not terminal:
            time.sleep(4)
            st, page = request("GET", f"/v1/sessions/{session_id}/events", query={"order": "asc", "limit": 200})
            if not isinstance(page, dict):
                continue
            for ev in page.get("data", []):
                t = ev.get("type", "?")
                seen_types[t] = seen_types.get(t, 0) + 1
                if "skill" in t.lower():
                    skill_events.append(t)
                blob = json.dumps(ev)
                if "PROBE57_MOUNT" in blob or "/skills" in blob or "SKILL.md" in blob:
                    for frag in blob.replace("\\n", "\n").split("\n"):
                        if "PROBE57_MOUNT" in frag or "SKILL.md" in frag:
                            mount_line = frag[:300]
            # terminal if the session went idle/completed
            sst, sbody = request("GET", f"/v1/sessions/{session_id}")
            status = sbody.get("status") if isinstance(sbody, dict) else None
            findings["last_session_status"] = status
            if status in ("idle", "completed", "ended", "failed", "error"):
                terminal = True

        findings["event_types_seen"] = seen_types
        findings["skill_specific_events"] = skill_events  # expect [] -> no skill.* vocab
        findings["mount_evidence"] = mount_line

    finally:
        cleanup: dict[str, Any] = {}
        if session_id:
            cleanup["session_archive"] = request("POST", f"/v1/sessions/{session_id}/archive")[0]
        if agent_id:
            cleanup["agent_archive"] = request("POST", f"/v1/agents/{agent_id}/archive")[0]
        if env_id:
            cleanup["env_delete"] = request("DELETE", f"/v1/environments/{env_id}")[0]
        if skill_id:
            for v in versions:
                request("DELETE", f"/v1/skills/{skill_id}/versions/{v}")
            cleanup["skill_delete"] = request("DELETE", f"/v1/skills/{skill_id}")[0]
        findings["cleanup"] = cleanup

    print(json.dumps(findings, indent=2, sort_keys=True, default=str))
    art = Path(__file__).parent / "artifacts" / "57-skills-execution-probe.json"
    art.parent.mkdir(exist_ok=True)
    art.write_text(json.dumps(findings, indent=2, sort_keys=True, default=str))
    print(f"\nwrote {art}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"PROBE57_FAIL: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise
