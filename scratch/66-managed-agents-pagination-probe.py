#!/usr/bin/env python3
"""Probe 66 — hosted CMA pagination and backward cursor semantics.

Run:
  uv run --with anthropic python scratch/66-managed-agents-pagination-probe.py

Reads the hosted credential directly from the workshop .env. Durable resource
IDs and opaque cursors are replaced by stable per-artifact pseudonyms.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Callable

import anthropic

API_KEY_ENV = Path("/Users/oner/dev/junk/cwc-workshops/.env")
MODEL = os.environ.get("OMA_PAGINATION_PROBE_MODEL", "claude-sonnet-5")
RUN_ID = uuid.uuid4().hex[:8]
ARTIFACT = Path(__file__).parent / "artifacts" / "66-managed-agents-pagination-probe.json"
ID_MAP: dict[str, str] = {}
CURSOR_MAP: dict[str, str] = {}
SESSION_LABELS: dict[str, str] = {}


def load_probe_key() -> str:
    for line in API_KEY_ENV.read_text().splitlines():
        if line.strip().startswith("ANTHROPIC_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit(f"ANTHROPIC_API_KEY not found in {API_KEY_ENV}")


def model_dump(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    return value


def pseudonym(mapping: dict[str, str], value: str, prefix: str) -> str:
    if value not in mapping:
        mapping[value] = f"{prefix}_{len(mapping) + 1:03d}"
    return mapping[value]


def public(value: Any, key: str | None = None) -> Any:
    value = model_dump(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        if key in {"next_page", "prev_page", "page", "after_id", "before_id"}:
            return pseudonym(CURSOR_MAP, value, "cursor")
        if value in SESSION_LABELS:
            return SESSION_LABELS[value]
        if value.startswith(("agent_", "env_", "sesn_", "skill_", "vault_", "file_")):
            return pseudonym(ID_MAP, value, "id")
        return value
    if isinstance(value, list):
        return [public(item) for item in value]
    if isinstance(value, dict):
        return {str(k): public(v, str(k)) for k, v in value.items()}
    return repr(value)


def page_shape(page: Any) -> dict[str, Any]:
    raw = model_dump(page)
    data = raw.get("data", []) if isinstance(raw, dict) else []
    return {
        "data": [
            SESSION_LABELS.get(str(item.get("id")), public(item.get("id")))
            if isinstance(item, dict)
            else public(item)
            for item in data
        ],
        "has_more": raw.get("has_more") if isinstance(raw, dict) else None,
        "next_page": public(raw.get("next_page"), "next_page") if isinstance(raw, dict) else None,
        "prev_page": public(raw.get("prev_page"), "prev_page") if isinstance(raw, dict) else None,
        "keys": sorted(raw.keys()) if isinstance(raw, dict) else [],
    }


def list_envelope_shape(page: Any) -> dict[str, Any]:
    raw = model_dump(page)
    if not isinstance(raw, dict):
        return {"type": type(raw).__name__}
    return {
        "keys": sorted(raw.keys()),
        "data_count": len(raw.get("data", [])) if isinstance(raw.get("data"), list) else None,
        **({"has_more": raw.get("has_more")} if "has_more" in raw else {}),
        **({"next_page": public(raw.get("next_page"), "next_page")} if "next_page" in raw else {}),
        **({"prev_page": public(raw.get("prev_page"), "prev_page")} if "prev_page" in raw else {}),
        **({"first_id_present": raw.get("first_id") is not None} if "first_id" in raw else {}),
        **({"last_id_present": raw.get("last_id") is not None} if "last_id" in raw else {}),
    }


def error_shape(exc: BaseException) -> dict[str, Any]:
    body = getattr(exc, "body", None)
    error = body.get("error") if isinstance(body, dict) else None
    return {
        "status_code": getattr(exc, "status_code", None),
        "error_type": error.get("type") if isinstance(error, dict) else None,
        "message": error.get("message") if isinstance(error, dict) else str(exc)[:500],
    }


def capture_error(call: Callable[[], Any]) -> dict[str, Any]:
    try:
        return {"response": public(call())}
    except Exception as exc:  # noqa: BLE001
        return {"error": error_shape(exc)}


def main() -> None:
    client = anthropic.Anthropic(api_key=load_probe_key())
    agent_id: str | None = None
    environment_id: str | None = None
    session_ids: list[str] = []
    result: dict[str, Any] = {"run_id": RUN_ID, "model": MODEL}
    try:
        agent = client.beta.agents.create(
            name=f"oma-probe66-pagination-{RUN_ID}",
            model=MODEL,
            tools=[{
                "type": "agent_toolset_20260401",
                "default_config": {"enabled": False},
            }],
        )
        agent_id = agent.id
        environment = client.beta.environments.create(
            name=f"oma-probe66-env-{RUN_ID}", config={"type": "cloud"}
        )
        environment_id = environment.id
        for index in range(5):
            session = client.beta.sessions.create(
                agent=agent_id,
                environment_id=environment_id,
                title=f"probe66-{index + 1}-{RUN_ID}",
            )
            session_ids.append(session.id)
            SESSION_LABELS[session.id] = f"session_{index + 1}"
            time.sleep(0.05)

        asc1 = client.beta.sessions.list(agent_id=agent_id, order="asc", limit=2)
        asc1_raw = model_dump(asc1)
        asc2 = client.beta.sessions.list(
            agent_id=agent_id, order="asc", limit=2, page=asc1_raw["next_page"]
        )
        asc2_raw = model_dump(asc2)
        asc_back = client.beta.sessions.list(
            agent_id=agent_id, order="asc", limit=2, page=asc2_raw["prev_page"]
        )
        asc3 = client.beta.sessions.list(
            agent_id=agent_id, order="asc", limit=2, page=asc2_raw["next_page"]
        )

        desc1 = client.beta.sessions.list(agent_id=agent_id, order="desc", limit=2)
        desc1_raw = model_dump(desc1)
        desc2 = client.beta.sessions.list(
            agent_id=agent_id, order="desc", limit=2, page=desc1_raw["next_page"]
        )
        desc2_raw = model_dump(desc2)
        desc_back = client.beta.sessions.list(
            agent_id=agent_id, order="desc", limit=2, page=desc2_raw["prev_page"]
        )

        result["sessions"] = {
            "asc": {
                "page_1": page_shape(asc1),
                "page_2": page_shape(asc2),
                "back_from_page_2": page_shape(asc_back),
                "page_3": page_shape(asc3),
            },
            "desc": {
                "page_1": page_shape(desc1),
                "page_2": page_shape(desc2),
                "back_from_page_2": page_shape(desc_back),
            },
            "invalid_cursor": capture_error(
                lambda: client.beta.sessions.list(
                    agent_id=agent_id, order="asc", limit=2, page="oma_probe_invalid_cursor"
                )
            ),
            "cursor_reuse_with_opposite_order": capture_error(
                lambda: client.beta.sessions.list(
                    agent_id=agent_id,
                    order="desc",
                    limit=2,
                    page=asc1_raw["next_page"],
                )
            ),
        }

        result["other_list_envelopes"] = {
            "agents": list_envelope_shape(client.beta.agents.list(limit=1)),
            "environments": list_envelope_shape(client.beta.environments.list(limit=1)),
            "skills": list_envelope_shape(client.beta.skills.list(limit=1)),
            "vaults": list_envelope_shape(client.beta.vaults.list(limit=1)),
            "files": list_envelope_shape(client.beta.files.list(limit=1)),
        }
    except Exception as exc:  # noqa: BLE001
        result["error"] = error_shape(exc)
    finally:
        for session_id in reversed(session_ids):
            try:
                client.beta.sessions.delete(session_id)
            except Exception:
                pass
        if agent_id:
            try:
                client.beta.agents.archive(agent_id)
            except Exception:
                pass
        if environment_id:
            try:
                client.beta.environments.delete(environment_id)
            except Exception:
                try:
                    client.beta.environments.archive(environment_id)
                except Exception:
                    pass

    ARTIFACT.parent.mkdir(exist_ok=True)
    ARTIFACT.write_text(json.dumps(public(result), indent=2, sort_keys=True))
    print(json.dumps(public(result), indent=2, sort_keys=True))
    print(f"\nwrote {ARTIFACT}")


if __name__ == "__main__":
    main()
