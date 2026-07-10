#!/usr/bin/env python3
"""Probe 56b — close the /v1/skills wire [Unk] items flagged by the panel.

Run:
  python3 scratch/56b-skills-wire-unknowns-probe.py

Loads ANTHROPIC_API_KEY from /Users/oner/dev/junk/cwc-workshops/.env.
Settles the accept-shapes and lifecycle unknowns that shape slice 1:
  1. root-level SKILL.md zip (no top folder) — accepted?
  2. path-qualified individual files[] (no zip) — accepted?
  3. omitted display_title — derived from SKILL.md?
  4. duplicate display_title — rejected?
  5. pagination continuation (limit=1 + next_page follow)
  6. referenced-skill deletion — can you delete a skill an agent references,
     and does the agent keep a dangling ref / reject re-attach?
  7. 30 MB request boundary (best-effort; ~31 MB random payload)
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
from pathlib import Path
from typing import Any

API = "https://api.anthropic.com"
VERSION = "2023-06-01"
BETA = "managed-agents-2026-04-01,skills-2025-10-02"
ENV_PATH = Path("/Users/oner/dev/junk/cwc-workshops/.env")
RUN = uuid.uuid4().hex[:8]


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
        with urllib.request.urlopen(req, timeout=180) as res:
            raw = res.read()
            return res.status, (json.loads(raw.decode() or "null") if raw else None)
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, (json.loads(raw.decode() or "null") if raw else None)
        except Exception:
            return err.code, raw.decode(errors="replace")[:400]


def keys_of(v: Any) -> Any:
    if isinstance(v, dict):
        return {k: (keys_of(x) if isinstance(x, (dict, list)) else (x if isinstance(x, str) and len(x) <= 80 else type(x).__name__)) for k, x in v.items()}
    if isinstance(v, list):
        return [keys_of(x) for x in v[:3]] + ([f"...+{len(v)-3}"] if len(v) > 3 else [])
    return v


def skill_md(name: str, extra: bytes = b"") -> str:
    return f"---\nname: {name}\ndescription: Probe 56b throwaway skill.\n---\n\n# {name}\n"


def zip_root(name: str) -> bytes:
    """SKILL.md at the ZIP ROOT (no top folder)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("SKILL.md", skill_md(name))
    return buf.getvalue()


def zip_folder(name: str, filler: int = 0) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED if filler else zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{name}/SKILL.md", skill_md(name))
        if filler:
            z.writestr(f"{name}/big.bin", os.urandom(filler))
    return buf.getvalue()


def multipart(fields: list[tuple[str, str]], files: list[tuple[str, str, bytes]]) -> tuple[bytes, str]:
    boundary = f"----probe56b{uuid.uuid4().hex}"
    out = io.BytesIO()
    for name, value in fields:
        out.write(f"--{boundary}\r\n".encode())
        out.write(f'Content-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    for field, filename, content in files:
        out.write(f"--{boundary}\r\n".encode())
        out.write(f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'.encode())
        out.write(b"Content-Type: application/octet-stream\r\n\r\n" + content + b"\r\n")
    out.write(f"--{boundary}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={boundary}"


def emit(k: str, p: Any) -> None:
    print(f"=== {k} ===")
    print(json.dumps(p, indent=2, default=str)[:900])


def create_skill(files, fields=None):
    data, ct = multipart(fields or [], files)
    return request("POST", "/v1/skills", multipart=data, content_type=ct)


def delete_skill(sid: str):
    # delete-only: versions first
    st, lv = request("GET", f"/v1/skills/{sid}/versions")
    if isinstance(lv, dict):
        for v in lv.get("data", []):
            request("DELETE", f"/v1/skills/{sid}/versions/{v.get('version')}")
    return request("DELETE", f"/v1/skills/{sid}")[0]


def main() -> None:
    f: dict[str, Any] = {"run": RUN}
    made: list[str] = []
    agent_id = None
    try:
        # 1. root-level SKILL.md zip
        st, b = create_skill([("files[]", "root.zip", zip_root(f"probe56b-root-{RUN}"))])
        f["root_zip"] = {"status": st, "body": keys_of(b)}
        if st == 200 and isinstance(b, dict):
            made.append(b["id"])

        # 2. path-qualified individual files (no zip)
        name = f"probe56b-files-{RUN}"
        st, b = create_skill([
            ("files[]", f"{name}/SKILL.md", skill_md(name).encode()),
        ])
        f["individual_files"] = {"status": st, "body": keys_of(b)}
        if st == 200 and isinstance(b, dict):
            made.append(b["id"])

        # 3. omitted display_title → derived?
        name = f"probe56b-derive-{RUN}"
        st, b = create_skill([("files[]", "d.zip", zip_folder(name))])
        f["derived_display_title"] = {"status": st, "display_title": b.get("display_title") if isinstance(b, dict) else None}
        derived_id = b.get("id") if isinstance(b, dict) else None
        if derived_id:
            made.append(derived_id)

        # 4. duplicate display_title → rejected?
        st, b = create_skill([("files[]", "d2.zip", zip_folder(f"probe56b-dupe-{RUN}"))],
                             fields=[("display_title", f"Probe 56b skill {RUN}")])
        first_dup = b.get("id") if (st == 200 and isinstance(b, dict)) else None
        if first_dup:
            made.append(first_dup)
        st2, b2 = create_skill([("files[]", "d3.zip", zip_folder(f"probe56b-dupe2-{RUN}"))],
                               fields=[("display_title", f"Probe 56b skill {RUN}")])
        f["duplicate_display_title"] = {"first": st, "second": st2, "second_body": keys_of(b2)}
        if st2 == 200 and isinstance(b2, dict):
            made.append(b2["id"])

        # 5. pagination continuation
        st, p1 = request("GET", "/v1/skills", query={"limit": 1})
        nxt = p1.get("next_page") if isinstance(p1, dict) else None
        st2, p2 = request("GET", "/v1/skills", query={"limit": 1, "page": nxt}) if nxt else (None, None)
        f["pagination"] = {"page1_has_more": p1.get("has_more") if isinstance(p1, dict) else None,
                           "page1_next": bool(nxt), "page2_status": st2,
                           "page2_first_id": (p2.get("data", [{}])[0].get("id") if isinstance(p2, dict) and p2.get("data") else None)}

        # 6. referenced-skill deletion
        if derived_id:
            st, ag = request("POST", "/v1/agents", body={
                "name": f"probe56b-agent-{RUN}", "model": "claude-sonnet-4-6",
                "skills": [{"type": "custom", "skill_id": derived_id}]})
            agent_id = ag.get("id") if isinstance(ag, dict) else None
            f["attach_before_delete"] = {"status": st}
            made_ref = derived_id
            made.remove(derived_id)  # we delete it explicitly here
            del_status = delete_skill(made_ref)
            f["delete_referenced_skill"] = {"status": del_status}
            # agent still echoes dangling ref?
            st, ag2 = request("GET", f"/v1/agents/{agent_id}") if agent_id else (None, None)
            f["agent_after_skill_delete"] = {"status": st,
                "skills": ag2.get("skills") if isinstance(ag2, dict) else None}
            # re-attach the now-deleted skill to a NEW agent → expect 400
            st, b = request("POST", "/v1/agents", body={
                "name": f"probe56b-reattach-{RUN}", "model": "claude-sonnet-4-6",
                "skills": [{"type": "custom", "skill_id": made_ref}]})
            f["reattach_deleted_skill"] = {"status": st, "body": keys_of(b)}
            if st == 200 and isinstance(b, dict):
                request("POST", f"/v1/agents/{b['id']}/archive")

        # 7. 30 MB boundary (best-effort ~31 MB random, uncompressed)
        try:
            big = zip_folder(f"probe56b-big-{RUN}", filler=31 * 1024 * 1024)
            st, b = create_skill([("files[]", "big.zip", big)])
            f["over_30mb"] = {"upload_bytes": len(big), "status": st, "body": keys_of(b)}
            if st == 200 and isinstance(b, dict):
                made.append(b["id"])
        except Exception as e:
            f["over_30mb"] = {"error": f"{type(e).__name__}: {e}"}

    finally:
        cleanup = {}
        if agent_id:
            cleanup["agent_archive"] = request("POST", f"/v1/agents/{agent_id}/archive")[0]
        for sid in made:
            cleanup[f"del_{sid[:12]}"] = delete_skill(sid)
        f["cleanup"] = cleanup

    emit("probe56b.findings", f)
    art = Path(__file__).parent / "artifacts" / "56b-skills-wire-unknowns-probe.json"
    art.parent.mkdir(exist_ok=True)
    art.write_text(json.dumps(f, indent=2, default=str))
    print(f"\nwrote {art}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"PROBE56B_FAIL: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise
