import type { JsonObject } from "./json.ts";

/**
 * Managed Agents event types — the wire shapes we publish to API clients.
 *
 * The `type` strings are Tier 1 wire-compatible per ADR 0004 — they must match
 * Anthropic's Managed Agents API verbatim. Per-type fields are deliberately
 * modeled as an open object at this layer; typed elaboration lives in the
 * route/translator layer where the discriminator gives us the variant.
 */

/**
 * Discriminator strings emitted by the platform. MVP subset; extend as needed.
 *
 * Declared as a runtime `as const` array so we can iterate it in alignment
 * tests (see `src/types/__tests__/events.test.ts`); the TS union is derived
 * via `typeof[number]` so the compile-time and runtime views can never drift.
 */
export const EVENT_TYPES = [
  // Agent-originated
  "agent.message",
  "agent.thinking",
  "agent.tool_use",
  "agent.tool_result",
  "agent.custom_tool_use",
  // Span observability
  "span.model_request_start",
  "span.model_request_end",
  // Session lifecycle
  "session.status_running",
  "session.status_idle",
  "session.status_rescheduled",
  "session.status_terminated",
  "session.deleted",
  "session.error",
  // User-originated (echoed back on the stream after server processes them)
  "user.message",
  "user.interrupt",
  "user.custom_tool_result",
  "user.tool_confirmation",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface ManagedAgentsEvent {
  /** Server-assigned event ID, prefixed `sevt_`. UUIDv7 for time-ordered cursor scans. */
  id: string;
  /** Event-type discriminator. Tier 1 wire-compatible. */
  type: EventType;
  /**
   * ISO 8601 timestamp once the event has been processed by the agent loop;
   * `null` while still queued. Mirrors Anthropic's `processed_at` semantics
   * for user-originated events; agent-originated events are always non-null.
   */
  processed_at: string | null;
  /** Event-specific top-level fields. Shape varies by `type`. */
  [key: string]: unknown;
}

export interface ManagedAgentsTextContentBlock {
  type: "text";
  text: string;
}

export interface ManagedAgentsOpaqueContentBlock extends JsonObject {
  type: string;
}

export type ManagedAgentsContentBlock =
  | ManagedAgentsTextContentBlock
  | ManagedAgentsOpaqueContentBlock;

export interface ManagedAgentsUserMessageEventInput {
  type: "user.message";
  content: ManagedAgentsContentBlock[];
}

export interface ManagedAgentsUserCustomToolResultEventInput {
  type: "user.custom_tool_result";
  custom_tool_use_id: string;
  content?: ManagedAgentsContentBlock[];
  is_error?: boolean;
}

export interface ManagedAgentsUserToolConfirmationEventInput {
  type: "user.tool_confirmation";
  tool_use_id: string;
  result: "allow" | "deny";
  deny_message?: string | null;
}

export interface ManagedAgentsUserInterruptEventInput {
  type: "user.interrupt";
}

export interface ManagedAgentsSpanModelUsage {
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
  speed?: "standard" | "fast" | null;
}

export interface ManagedAgentsSpanModelRequestEndPayload {
  model_request_start_id: string;
  is_error: boolean | null;
  model_usage: ManagedAgentsSpanModelUsage;
}

export type ManagedAgentsUserEventInput =
  | ManagedAgentsUserMessageEventInput
  | ManagedAgentsUserInterruptEventInput
  | ManagedAgentsUserCustomToolResultEventInput
  | ManagedAgentsUserToolConfirmationEventInput;

export interface SendSessionEventsRequest {
  events: ManagedAgentsUserEventInput[];
}

export interface SendSessionEventsResponse {
  data: ManagedAgentsEvent[];
}

export interface ListSessionEventsResponse {
  data: ManagedAgentsEvent[];
  next_page: string | null;
}

/**
 * Generate a UUIDv7 — time-ordered 128-bit ID with a 48-bit millisecond
 * timestamp prefix. Used so lexical sort = chronological sort, which makes
 * `WHERE id > ? ORDER BY id` a valid cursor scan in SQLite.
 *
 * Strict intra-process monotonicity via **counter-based** scheme (RFC 9562
 * §6.2 Method 1, with random seeding per Method 3): when multiple IDs are
 * minted in the same millisecond, a 12-bit counter in `rand_a` advances
 * deterministically. This preserves real-clock fidelity in the embedded `ms`
 * field — code-review MEDIUM 4 finding fixed (no more timestamp inflation).
 *
 * Layout (per RFC 9562 §5.7):
 *   bits  0-47   unix_ts_ms (48-bit ms)
 *   bits 48-51   ver (constant 0b0111)
 *   bits 52-63   counter (12-bit monotonic within an ms)
 *   bits 64-65   var (constant 0b10)
 *   bits 66-127  random (62 bits)
 *
 * Counter behavior:
 *   - When `ms` advances: counter seeded with random 0..2047 (leaves 2048
 *     increments of headroom within the ms; mitigates cross-process collisions)
 *   - When `ms` is equal or earlier (clock tied or rewound): counter bumps;
 *     if it overflows 0xFFF we borrow 1ms (this is the only path that inflates
 *     timestamps, and only by 1ms per 4096-ID burst within a single ms)
 *
 * Spec: https://datatracker.ietf.org/doc/rfc9562/ §5.7 + §6.2
 */
let lastMs = 0n;
let lastCounter = 0;

export function uuidv7(): string {
  let ms = BigInt(Date.now());
  let counter: number;

  if (ms > lastMs) {
    lastMs = ms;
    // Seed counter with random 0..2047 (top bit clear → 2048 increments
    // available before counter overflow within the same ms).
    counter = crypto.getRandomValues(new Uint16Array(1))[0] & 0x07ff;
    lastCounter = counter;
  } else {
    // Same ms (or rewound clock). Reuse lastMs; bump counter.
    ms = lastMs;
    lastCounter += 1;
    if (lastCounter > 0x0fff) {
      // 12-bit counter overflow. Borrow 1ms (only timestamp-inflation path).
      lastMs += 1n;
      ms = lastMs;
      counter = crypto.getRandomValues(new Uint16Array(1))[0] & 0x07ff;
      lastCounter = counter;
    } else {
      counter = lastCounter;
    }
  }

  const random = crypto.getRandomValues(new Uint8Array(8));

  const b0 = Number((ms >> 40n) & 0xffn);
  const b1 = Number((ms >> 32n) & 0xffn);
  const b2 = Number((ms >> 24n) & 0xffn);
  const b3 = Number((ms >> 16n) & 0xffn);
  const b4 = Number((ms >> 8n) & 0xffn);
  const b5 = Number(ms & 0xffn);
  // version 7 (high nibble) | top 4 bits of 12-bit counter (low nibble)
  const b6 = 0x70 | ((counter >> 8) & 0x0f);
  // low 8 bits of 12-bit counter
  const b7 = counter & 0xff;
  // variant 0b10 (high 2 bits) | 6 random bits
  const b8 = 0x80 | (random[0] & 0x3f);
  const b9 = random[1];
  const tail = random.slice(2); // 6 random bytes

  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return [
    hex(b0) + hex(b1) + hex(b2) + hex(b3),
    hex(b4) + hex(b5),
    hex(b6) + hex(b7),
    hex(b8) + hex(b9),
    [...tail].map(hex).join(""),
  ].join("-");
}

/** Convenience: prefixed event ID. */
export function newEventId(): string {
  return `sevt_${uuidv7()}`;
}
