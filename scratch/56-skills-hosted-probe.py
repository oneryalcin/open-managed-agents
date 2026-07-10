#!/usr/bin/env python3
"""Probe 56 — hosted Managed Agents Skills API (/v1/skills) wire shapes.

Run:
  python3 scratch/56-skills-hosted-probe.py

Loads ANTHROPIC_API_KEY from /Users/oner/dev/junk/cwc-workshops/.env.
Records response shapes, IDs, and validation error codes only. Closes the
plan-0126 wire unknowns:
  1. CreateSkill (multipart zip) response shape
  2. GetSkill / ListSkills / versions envelopes
  3. Attach validation: >20 skills, unknown custom id, anthropic+version,
     tools-cleared-with-skills (read-tool coupling), bad type
  4. delete-only lifecycle (must delete versions before the skill)
"""

from __future__ import annotations

import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

API = "https://api.anthropic.com"
VERSION = "2023-06-01"
BETA_MA = "managed-agents-2026-04-01"
BETA_SKILLS = "skills-2025-10-02"
BETA_BOTH = f"{BETA_MA},{BETA_SKILLS}"
ENV_PATH = Path("/Users/oner/dev/junk/cwc-workshops/.env")
RUN = uuid.uuid4().hex[:8]
SKILL_NAME = f"probe56-{RUN}"


def load_env_key() -> str:
    if not ENV_PATH.exists():
        raise SystemExit(f"missing env file: {ENV_PATH}")
    for line in ENV_PATH.read_text().splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        if k.strip() == "ANTHROPIC_API_KEY":
            v = v.strip().strip("'").strip('"')
            if v:
                return v
    raise SystemExit(f"ANTHROPIC_API_KEY not found in {ENV_PATH}")


API_KEY = load_env_key()


@dataclass
class ApiResult:
    status: int
    body: Any
    headers: dict[str, str]


def request(method: str, path: str, *, body: Any = None, multipart: bytes | None = None,
            content_type: str | None = None, beta: str = BETA_BOTH,
            query: dict[str, Any] | None = None) -> ApiResult:
    url = API + path
    if query:
        url += "?" + urllib.parse.urlencode(query, doseq=True)
    headers = {"x-api-key": API_KEY, "anthropic-version": VERSION, "anthropic-beta": beta}
    data: bytes | None = None
    if multipart is not None:
        data = multipart
        headers["content-type"] = content_type or "application/octet-stream"
    elif body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            raw = res.read()
            return ApiResult(res.status, json.loads(raw.decode() or "null") if raw else None, dict(res.headers))
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            parsed = json.loads(raw.decode() or "null") if raw else None
        except Exception:
            parsed = raw.decode(errors="replace")[:800]
        return ApiResult(err.code, parsed, dict(err.headers))


def keys_of(value: Any) -> Any:
    """Structural shape: keys + value types, values kept only for small scalars."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if isinstance(v, (dict, list)):
                out[k] = keys_of(v)
            elif isinstance(v, str) and len(v) <= 64:
                out[k] = v
            else:
                out[k] = type(v).__name__
        return out
    if isinstance(value, list):
        return [keys_of(v) for v in value[:3]] + ([f"...+{len(value)-3}"] if len(value) > 3 else [])
    return value


def make_skill_zip(name: str, top_folder: bool = True) -> bytes:
    skill_md = (
        f"---\nname: {name}\n"
        f"description: Probe 56 throwaway skill; greets and reports its own path.\n"
        "---\n\n# Probe skill\n\nWhen asked to run the probe skill, print PROBE56_OK and "
        "the absolute path of this SKILL.md file.\n"
    )
    script = "#!/usr/bin/env bash\necho PROBE56_OK\n"
    buf = io.BytesIO()
    prefix = f"{name}/" if top_folder else ""
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{prefix}SKILL.md", skill_md)
        z.writestr(f"{prefix}scripts/run.sh", script)
    return buf.getvalue()


def multipart_body(fields: list[tuple[str, str]], files: list[tuple[str, str, bytes]]) -> tuple[bytes, str]:
    boundary = f"----probe56{uuid.uuid4().hex}"
    out = io.BytesIO()
    for name, value in fields:
        out.write(f"--{boundary}\r\n".encode())
        out.write(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        out.write(f"{value}\r\n".encode())
    for name, filename, content in files:
        out.write(f"--{boundary}\r\n".encode())
        out.write(f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode())
        out.write(b"Content-Type: application/zip\r\n\r\n")
        out.write(content)
        out.write(b"\r\n")
    out.write(f"--{boundary}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={boundary}"


def emit(kind: str, payload: Any) -> None:
    print(f"=== {kind} ===")
    print(json.dumps(payload, indent=2, sort_keys=True, default=str))


def main() -> None:
    findings: dict[str, Any] = {"run": RUN}
    created_skill_id: str | None = None
    versions: list[str] = []
    try:
        # --- 1. CreateSkill (multipart zip) ---
        zip_bytes = make_skill_zip(SKILL_NAME)
        data, ctype = multipart_body(
            [("display_title", f"Probe 56 skill {RUN}")],
            [("files[]", f"{SKILL_NAME}.zip", zip_bytes)],
        )
        created = request("POST", "/v1/skills", multipart=data, content_type=ctype)
        findings["create_skill"] = {"status": created.status, "body": keys_of(created.body)}
        if created.status in (200, 201) and isinstance(created.body, dict):
            created_skill_id = created.body.get("id")
            v = created.body.get("latest_version")
            if v:
                versions.append(v)

        # --- 2. GetSkill / ListSkills envelopes ---
        if created_skill_id:
            got = request("GET", f"/v1/skills/{created_skill_id}")
            findings["get_skill"] = {"status": got.status, "body": keys_of(got.body)}
        listed = request("GET", "/v1/skills", query={"limit": 3})
        findings["list_skills"] = {"status": listed.status, "envelope": keys_of(listed.body)}

        # --- 3. Versions ---
        if created_skill_id:
            vzip, vctype = multipart_body([], [("files[]", f"{SKILL_NAME}.zip", make_skill_zip(SKILL_NAME))])
            newver = request("POST", f"/v1/skills/{created_skill_id}/versions", multipart=vzip, content_type=vctype)
            findings["create_version"] = {"status": newver.status, "body": keys_of(newver.body)}
            if newver.status in (200, 201) and isinstance(newver.body, dict) and newver.body.get("version"):
                versions.append(newver.body["version"])
            lv = request("GET", f"/v1/skills/{created_skill_id}/versions")
            findings["list_versions"] = {"status": lv.status, "envelope": keys_of(lv.body)}
            if versions:
                gv = request("GET", f"/v1/skills/{created_skill_id}/versions/{versions[0]}")
                findings["get_version"] = {"status": gv.status, "body": keys_of(gv.body)}

        # --- 4. Attach validation via agent-create ---
        def agent_body(skills: Any, tools: Any = None) -> dict[str, Any]:
            b: dict[str, Any] = {"name": f"probe56-agent-{RUN}-{uuid.uuid4().hex[:4]}",
                                 "model": "claude-sonnet-4-6", "skills": skills}
            if tools is not None:
                b["tools"] = tools
            return b

        # 4a. anthropic skill WITH version — accepted / ignored / rejected?
        r = request("POST", "/v1/agents", body=agent_body([{"type": "anthropic", "skill_id": "xlsx", "version": "latest"}]))
        findings["attach_anthropic_with_version"] = {"status": r.status, "body": keys_of(r.body)}
        if r.status == 200 and isinstance(r.body, dict):
            request("POST", f"/v1/agents/{r.body.get('id')}/archive")

        # 4b. bad type
        r = request("POST", "/v1/agents", body=agent_body([{"type": "bogus", "skill_id": "xlsx"}]))
        findings["attach_bad_type"] = {"status": r.status, "body": keys_of(r.body)}

        # 4c. unknown custom skill_id
        r = request("POST", "/v1/agents", body=agent_body([{"type": "custom", "skill_id": "skill_doesnotexist000"}]))
        findings["attach_unknown_custom"] = {"status": r.status, "body": keys_of(r.body)}

        # 4d. >20 skills (cap)
        many = [{"type": "anthropic", "skill_id": "xlsx"}] * 21
        r = request("POST", "/v1/agents", body=agent_body(many))
        findings["attach_over_cap"] = {"status": r.status, "body": keys_of(r.body)}

        # 4e. skills present but tools cleared (read-tool coupling)
        r = request("POST", "/v1/agents", body=agent_body([{"type": "anthropic", "skill_id": "xlsx"}], tools=[]))
        findings["attach_skills_tools_cleared"] = {"status": r.status, "body": keys_of(r.body)}

        # 4f. baseline: valid anthropic skill, no tools override (should succeed)
        r = request("POST", "/v1/agents", body=agent_body([{"type": "anthropic", "skill_id": "xlsx"}]))
        findings["attach_valid_baseline"] = {"status": r.status, "body": keys_of(r.body)}
        if r.status == 200 and isinstance(r.body, dict):
            request("POST", f"/v1/agents/{r.body.get('id')}/archive")

    finally:
        # --- 5. Cleanup + delete-only lifecycle probe ---
        cleanup: dict[str, Any] = {}
        if created_skill_id:
            # Try deleting the skill while versions exist (expect 4xx per docs).
            direct = request("DELETE", f"/v1/skills/{created_skill_id}")
            cleanup["delete_skill_with_versions"] = {"status": direct.status, "body": keys_of(direct.body)}
            if direct.status not in (200, 204):
                for v in versions:
                    dv = request("DELETE", f"/v1/skills/{created_skill_id}/versions/{v}")
                    cleanup[f"delete_version_{v[:8]}"] = {"status": dv.status}
                final = request("DELETE", f"/v1/skills/{created_skill_id}")
                cleanup["delete_skill_after_versions"] = {"status": final.status}
        findings["cleanup"] = cleanup

    emit("probe56.findings", findings)
    art = Path(__file__).parent / "artifacts" / "56-skills-hosted-probe.json"
    art.parent.mkdir(exist_ok=True)
    art.write_text(json.dumps(findings, indent=2, sort_keys=True, default=str))
    print(f"\nwrote {art}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"PROBE56_FAIL: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise
