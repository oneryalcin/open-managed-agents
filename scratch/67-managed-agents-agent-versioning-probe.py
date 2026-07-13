#!/usr/bin/env python3
"""Probe 67 — hosted CMA agent update and immutable version semantics.

Run:
  uv run --with anthropic python scratch/67-managed-agents-agent-versioning-probe.py

Reads ANTHROPIC_API_KEY directly from the workshop .env. Hosted IDs and cursors
are replaced with stable pseudonyms in the artifact.
"""
from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path
from typing import Any, Callable

import anthropic

API_KEY_ENV = Path("/Users/oner/dev/junk/cwc-workshops/.env")
MODEL = os.environ.get("OMA_AGENT_VERSION_PROBE_MODEL", "claude-sonnet-5")
RUN_ID = uuid.uuid4().hex[:8]
ARTIFACT = Path(__file__).parent / "artifacts" / "67-managed-agents-agent-versioning-probe.json"
ID_MAP: dict[str, str] = {}
CURSOR_MAP: dict[str, str] = {}


def load_probe_key() -> str:
    for line in API_KEY_ENV.read_text().splitlines():
        if line.strip().startswith("ANTHROPIC_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit(f"ANTHROPIC_API_KEY not found in {API_KEY_ENV}")


def dump(value: Any) -> Any:
    return value.model_dump(mode="json") if hasattr(value, "model_dump") else value


def alias(mapping: dict[str, str], value: str, prefix: str) -> str:
    if value not in mapping:
        mapping[value] = f"{prefix}_{len(mapping) + 1:03d}"
    return mapping[value]


def public(value: Any, key: str | None = None) -> Any:
    value = dump(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        if key in {"next_page", "page"}:
            return alias(CURSOR_MAP, value, "cursor")
        if re.fullmatch(r"(?:agent|env|sesn)_[0-9a-f-]{8,}", value):
            return alias(ID_MAP, value, "id")
        if key in {"created_at", "updated_at", "archived_at"}:
            return "timestamp" if value else value
        return value
    if isinstance(value, list):
        return [public(item) for item in value]
    if isinstance(value, dict):
        return {str(k): public(v, str(k)) for k, v in value.items()}
    return repr(value)


def error_shape(exc: BaseException) -> dict[str, Any]:
    body = getattr(exc, "body", None)
    error = body.get("error") if isinstance(body, dict) else None
    return {
        "status_code": getattr(exc, "status_code", None),
        "error_type": error.get("type") if isinstance(error, dict) else None,
        "message": error.get("message") if isinstance(error, dict) else str(exc)[:500],
    }


def capture(call: Callable[[], Any], shape: Callable[[Any], Any] = public) -> dict[str, Any]:
    try:
        return {"response": shape(call())}
    except Exception as exc:  # noqa: BLE001
        return {"error": error_shape(exc)}


def agent_shape(value: Any) -> dict[str, Any]:
    raw = dump(value)
    assert isinstance(raw, dict)
    return {
        "keys": sorted(raw.keys()),
        "id": public(raw.get("id")),
        "type": raw.get("type"),
        "version": raw.get("version"),
        "name": raw.get("name"),
        "description": raw.get("description"),
        "model": raw.get("model"),
        "system": raw.get("system"),
        "metadata": raw.get("metadata"),
        "created_at": public(raw.get("created_at"), "created_at"),
        "updated_at": public(raw.get("updated_at"), "updated_at"),
        "archived_at": public(raw.get("archived_at"), "archived_at"),
    }


def page_shape(value: Any) -> dict[str, Any]:
    raw = dump(value)
    assert isinstance(raw, dict)
    return {
        "keys": sorted(raw.keys()),
        "versions": [item.get("version") for item in raw.get("data", [])],
        "next_page": public(raw.get("next_page"), "next_page"),
    }


def session_shape(value: Any) -> dict[str, Any]:
    raw = dump(value)
    assert isinstance(raw, dict)
    return {
        "id": public(raw.get("id")),
        "agent": public(raw.get("agent")),
        "status": raw.get("status"),
    }


def main() -> None:
    client = anthropic.Anthropic(api_key=load_probe_key())
    agent_id: str | None = None
    environment_id: str | None = None
    session_ids: list[str] = []
    result: dict[str, Any] = {"run_id": RUN_ID, "model": MODEL}
    try:
        created = client.beta.agents.create(
            name=f"probe67-v1-{RUN_ID}",
            description="version one",
            model=MODEL,
            system="system-v1",
            metadata={"stable": "one", "remove_me": "yes"},
            tools=[{"type": "agent_toolset_20260401", "default_config": {"enabled": False}}],
        )
        agent_id = created.id
        result["create"] = agent_shape(created)

        updated_v2 = client.beta.agents.update(
            agent_id,
            version=1,
            name=f"probe67-v2-{RUN_ID}",
            description="version two",
            system="system-v2",
            metadata={"stable": "two", "added": "new", "remove_me": None},
        )
        result["update_v1_to_v2"] = agent_shape(updated_v2)
        result["stale_update_from_v1"] = capture(
            lambda: client.beta.agents.update(agent_id, version=1, description="stale")
        )

        updated_v3 = client.beta.agents.update(
            agent_id,
            version=2,
            description=None,
            system=None,
            metadata={"added": None},
        )
        result["update_v2_to_v3_nulls"] = agent_shape(updated_v3)
        result["retrieve"] = {
            "latest": agent_shape(client.beta.agents.retrieve(agent_id)),
            "version_1": agent_shape(client.beta.agents.retrieve(agent_id, version=1)),
            "version_2": agent_shape(client.beta.agents.retrieve(agent_id, version=2)),
            "missing_version": capture(lambda: client.beta.agents.retrieve(agent_id, version=999)),
        }

        versions_1 = client.beta.agents.versions.list(agent_id, limit=2)
        versions_1_raw = dump(versions_1)
        result["versions"] = {"page_1": page_shape(versions_1)}
        if isinstance(versions_1_raw, dict) and versions_1_raw.get("next_page"):
            result["versions"]["page_2"] = page_shape(
                client.beta.agents.versions.list(
                    agent_id, limit=2, page=versions_1_raw["next_page"]
                )
            )

        environment = client.beta.environments.create(
            name=f"probe67-env-{RUN_ID}", config={"type": "cloud"}
        )
        environment_id = environment.id
        latest_session = client.beta.sessions.create(
            agent=agent_id, environment_id=environment_id, title=f"probe67-latest-{RUN_ID}"
        )
        session_ids.append(latest_session.id)
        pinned_session = client.beta.sessions.create(
            agent={"type": "agent", "id": agent_id, "version": 1},
            environment_id=environment_id,
            title=f"probe67-pinned-{RUN_ID}",
        )
        session_ids.append(pinned_session.id)
        result["session_selection"] = {
            "bare_agent_id": session_shape(latest_session),
            "explicit_version_1": session_shape(pinned_session),
            "missing_version": capture(
                lambda: client.beta.sessions.create(
                    agent={"type": "agent", "id": agent_id, "version": 999},
                    environment_id=environment_id,
                    title=f"probe67-missing-{RUN_ID}",
                )
            ),
        }

        archived = client.beta.agents.archive(agent_id)
        result["archive"] = agent_shape(archived)
        result["after_archive"] = {
            "update": capture(
                lambda: client.beta.agents.update(agent_id, version=3, description="after archive"),
                agent_shape,
            ),
            "retrieve_latest": capture(lambda: client.beta.agents.retrieve(agent_id), agent_shape),
            "retrieve_v1": capture(
                lambda: client.beta.agents.retrieve(agent_id, version=1), agent_shape
            ),
            "versions": capture(lambda: client.beta.agents.versions.list(agent_id), page_shape),
        }
    except Exception as exc:  # noqa: BLE001
        result["fatal_error"] = error_shape(exc)
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
