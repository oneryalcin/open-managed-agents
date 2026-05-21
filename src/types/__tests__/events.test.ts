/**
 * Event-type alignment tests (v1).
 *
 * Catches the wire-contract drift bug class we already paid for in code review:
 * the `tool_use_id` vs `custom_tool_use_id` field-name mixup in ADR 0005's
 * pseudocode. If we add or rename an event type without updating every
 * consumer, this test should yell.
 *
 * v1 is intentionally narrow: we have no route handlers, no Zod schemas,
 * no emissions yet. So we assert two invariants the EventType union is
 * load-bearing for:
 *
 *   1. Every value in EVENT_TYPES matches the wire format
 *      (Tier 1 wire-compatible per ADR 0004).
 *   2. EVENT_TYPES exactly matches a hardcoded canonical wire-compat registry
 *      (catches additions/removals — every change to the union forces a
 *      change to this hardcoded list, which IS the audit trail).
 *
 * v2 (when route handlers + Zod schemas exist — see ADR 0008): regex-scan
 * the route handlers and schema files for emitted event-type literals and
 * assert each appears in EVENT_TYPES. That catches "engine emits a type
 * that's missing from the union" — typically introduced on rarely-exercised
 * branches (e.g., a cancellation path adds `session.aborted` but the union
 * doesn't, so client badge/icon maps fall through to the default).
 */

import { describe, expect, it } from "vitest";
import { EVENT_TYPES, type EventType } from "../events.ts";

/**
 * The canonical wire-compatible event types, per ADR 0004 Tier 1.
 *
 * This list is the SOURCE OF TRUTH for "what events does the Managed Agents
 * API surface emit and accept." Adding an event type means updating BOTH
 * `EVENT_TYPES` (in events.ts) AND this list. If they drift, this test fails.
 *
 * Why a hardcoded duplicate? Because the alignment is the whole point. If we
 * derived this list from EVENT_TYPES we'd be tautologically comparing a thing
 * to itself.
 */
const WIRE_COMPATIBLE_EVENT_TYPES = [
  // Agent-originated
  "agent.message",
  "agent.thinking",
  "agent.tool_use",
  "agent.tool_result",
  "agent.custom_tool_use",
  // Session lifecycle
  "session.status_running",
  "session.status_idle",
  "session.status_terminated",
  "session.error",
  // User-originated
  "user.message",
  "user.interrupt",
  "user.custom_tool_result",
  "user.tool_confirmation",
] as const satisfies readonly EventType[];

/** Wire format: `(agent|session|user|span).snake_case_lowercase`. */
const WIRE_FORMAT = /^(agent|session|user|span)\.[a-z]+(?:_[a-z]+)*$/;

describe("EventType wire contract", () => {
  it("EVENT_TYPES matches the hardcoded wire-compatible registry", () => {
    const declared = [...EVENT_TYPES].sort();
    const expected = [...WIRE_COMPATIBLE_EVENT_TYPES].sort();
    expect(declared).toEqual(expected);
  });

  it("every event type follows the wire format", () => {
    for (const t of EVENT_TYPES) {
      expect(t).toMatch(WIRE_FORMAT);
    }
  });

  it("no duplicates in EVENT_TYPES", () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it("every type starts with one of the four allowed namespaces", () => {
    const allowed = new Set(["agent", "session", "user", "span"]);
    for (const t of EVENT_TYPES) {
      const ns = t.split(".")[0];
      expect(allowed.has(ns!)).toBe(true);
    }
  });

  it("`user.custom_tool_result` is present (the custom tool result regression check)", () => {
    // Specifically guards the custom-tool result path from drifting back toward
    // generic tool-result naming. The event type must stay user.custom_tool_result,
    // and the event payload field must use custom_tool_use_id (covered by the
    // custom-tool round-trip spec) rather than tool_use_id.
    expect(EVENT_TYPES).toContain("user.custom_tool_result");
    expect(EVENT_TYPES).not.toContain("user.tool_result" as never);
  });
});
