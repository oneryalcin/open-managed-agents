#!/usr/bin/env python3
"""Live hosted Managed Agents probe for span event shape.

This intentionally targets Anthropic's hosted API, not local OMA. It creates a
minimal hosted agent/session, sends one user.message, lists the raw session
events, and reports any span-shape differences from OMA's current expected
surface.

Requires:
  ANTHROPIC_API_KEY

Optional:
  OMA_HOSTED_SPAN_PROBE_MODEL (default: claude-haiku-4-5)
  OMA_HOSTED_SPAN_PROBE_OUT (default: scratch/artifacts/37-...json)

Run:
  uv run --with anthropic --with python-dotenv \
    python scratch/37-managed-agents-hosted-span-shape-probe.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import time
from typing import Any

import anthropic
from dotenv import load_dotenv

load_dotenv(Path("examples/ship-your-first-managed-agent/.env"))

MODEL = os.environ.get("OMA_HOSTED_SPAN_PROBE_MODEL", "claude-haiku-4-5")
BETA = os.environ.get("OMA_MANAGED_AGENTS_BETA", "managed-agents-2026-04-01")
RUN_ID = f"{int(time.time())}-{os.getpid()}"
OUT_PATH = Path(
    os.environ.get(
        "OMA_HOSTED_SPAN_PROBE_OUT",
        f"scratch/artifacts/37-managed-agents-hosted-span-shape-{RUN_ID}.json",
    )
)

EVENT_ENVELOPE_KEYS = {"id", "processed_at", "type"}
OMA_SPAN_START_PAYLOAD_KEYS: set[str] = set()
OMA_SPAN_END_PAYLOAD_KEYS = {"is_error", "model_request_start_id", "model_usage"}
OMA_MODEL_USAGE_KEYS = {
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "input_tokens",
    "output_tokens",
    "speed",
}


def public(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [public(item) for item in value]
    if isinstance(value, dict):
        return {str(key): public(val) for key, val in value.items()}
    if hasattr(value, "model_dump"):
        return public(value.model_dump())
    if hasattr(value, "__dict__"):
        return public(
            {
                key: val
                for key, val in vars(value).items()
                if not key.startswith("_")
            }
        )
    return repr(value)


def emit(label: str, value: Any) -> None:
    print(f"## {label}")
    print(json.dumps(public(value), indent=2, sort_keys=True, default=str))


def event_type(event: Any) -> str:
    return str(getattr(event, "type", ""))


def text_from_blocks(blocks: Any) -> str:
    out: list[str] = []
    for block in blocks or []:
        if getattr(block, "type", None) == "text":
            out.append(str(getattr(block, "text", "")))
    return "".join(out)


def cleanup(client: anthropic.Anthropic, created: dict[str, str]) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    session_id = created.get("session_id")
    if session_id:
        try:
            actions.append({"session.delete": public(client.beta.sessions.delete(session_id))})
        except Exception as exc:  # noqa: BLE001
            actions.append({"session.delete.error": error_shape(exc)})
    agent_id = created.get("agent_id")
    if agent_id:
        try:
            actions.append({"agent.archive": public(client.beta.agents.archive(agent_id))})
        except Exception as exc:  # noqa: BLE001
            actions.append({"agent.archive.error": error_shape(exc)})
    env_id = created.get("environment_id")
    if env_id:
        try:
            actions.append(
                {"environment.delete": public(client.beta.environments.delete(env_id))}
            )
        except Exception as exc:  # noqa: BLE001
            actions.append({"environment.delete.error": error_shape(exc)})
    return actions


def error_shape(exc: BaseException) -> dict[str, Any]:
    return {
        "type": type(exc).__name__,
        "status_code": getattr(exc, "status_code", None),
        "message": str(exc)[:1000],
    }


def span_diff(spans: list[dict[str, Any]]) -> dict[str, Any]:
    starts = [span for span in spans if span.get("type") == "span.model_request_start"]
    ends = [span for span in spans if span.get("type") == "span.model_request_end"]
    start_payload_keys = sorted(
        {key for span in starts for key in span.keys()} - EVENT_ENVELOPE_KEYS
    )
    end_payload_keys = sorted(
        {key for span in ends for key in span.keys()} - EVENT_ENVELOPE_KEYS
    )
    usage_keys = sorted(
        {
            key
            for span in ends
            for key in (span.get("model_usage") or {}).keys()
            if isinstance(span.get("model_usage"), dict)
        }
    )
    return {
        "span_start_count": len(starts),
        "span_end_count": len(ends),
        "start_payload_keys": start_payload_keys,
        "start_extra_vs_oma": sorted(set(start_payload_keys) - OMA_SPAN_START_PAYLOAD_KEYS),
        "start_missing_vs_oma": sorted(OMA_SPAN_START_PAYLOAD_KEYS - set(start_payload_keys)),
        "end_payload_keys": end_payload_keys,
        "end_extra_vs_oma": sorted(set(end_payload_keys) - OMA_SPAN_END_PAYLOAD_KEYS),
        "end_missing_vs_oma": sorted(OMA_SPAN_END_PAYLOAD_KEYS - set(end_payload_keys)),
        "model_usage_keys": usage_keys,
        "model_usage_extra_vs_oma": sorted(set(usage_keys) - OMA_MODEL_USAGE_KEYS),
        "model_usage_missing_vs_oma": sorted(OMA_MODEL_USAGE_KEYS - set(usage_keys)),
        "linked_start_ids": [
            {
                "end_id": span.get("id"),
                "model_request_start_id": span.get("model_request_start_id"),
                "links_to_known_start": span.get("model_request_start_id")
                in {start.get("id") for start in starts},
            }
            for span in ends
        ],
    }


def main() -> int:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise SystemExit("ANTHROPIC_API_KEY is required")

    client = anthropic.Anthropic(
        api_key=api_key,
        default_headers={"anthropic-beta": BETA},
        max_retries=0,
        timeout=120,
    )
    created: dict[str, str] = {}
    cleanup_actions: list[dict[str, Any]] = []
    result: dict[str, Any] = {
        "run_id": RUN_ID,
        "model": MODEL,
        "beta": BETA,
    }
    try:
        agent = client.beta.agents.create(
            name=f"oma-hosted-span-shape-{RUN_ID}",
            model=MODEL,
            system="Reply with one short sentence.",
            tools=[],
        )
        created["agent_id"] = agent.id
        env = client.beta.environments.create(
            name=f"oma-hosted-span-shape-{RUN_ID}",
            config={"type": "cloud", "networking": {"type": "unrestricted"}},
        )
        created["environment_id"] = env.id
        session = client.beta.sessions.create(agent=agent.id, environment_id=env.id)
        created["session_id"] = session.id
        result["created"] = created.copy()

        seen: list[dict[str, Any]] = []
        transcript = ""
        with client.beta.sessions.events.stream(session.id) as stream:
            client.beta.sessions.events.send(
                session.id,
                events=[
                    {
                        "type": "user.message",
                        "content": [
                            {
                                "type": "text",
                                "text": "Say exactly: hosted span probe ok",
                            }
                        ],
                    }
                ],
            )
            deadline = time.monotonic() + 120
            for event in stream:
                seen.append(
                    {
                        "id": getattr(event, "id", None),
                        "type": event_type(event),
                        "keys": sorted(public(event).keys())
                        if isinstance(public(event), dict)
                        else [],
                    }
                )
                if event_type(event) == "agent.message":
                    transcript += text_from_blocks(getattr(event, "content", []))
                if event_type(event) == "session.status_idle":
                    stop_reason = getattr(event, "stop_reason", None)
                    if getattr(stop_reason, "type", None) == "end_turn":
                        break
                if time.monotonic() > deadline:
                    raise TimeoutError("timed out waiting for hosted session idle")

        listed = client.beta.sessions.events.list(session.id, order="asc", limit=100)
        raw_events = [public(event) for event in listed.data]
        spans = [
            event
            for event in raw_events
            if isinstance(event, dict) and str(event.get("type", "")).startswith("span.")
        ]
        result.update(
            {
                "stream_seen": seen,
                "replay_types": [
                    event.get("type") for event in raw_events if isinstance(event, dict)
                ],
                "assistant_text": transcript,
                "span_diff": span_diff(spans),
                "raw_spans": spans,
            }
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        result["error"] = error_shape(exc)
        return 2
    finally:
        cleanup_actions = cleanup(client, created)
        result["cleanup"] = cleanup_actions
        OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUT_PATH.write_text(json.dumps(result, indent=2, sort_keys=True, default=str) + "\n")
        emit("hosted.span_shape.result", result)
        emit("hosted.span_shape.output", str(OUT_PATH))


if __name__ == "__main__":
    raise SystemExit(main())
