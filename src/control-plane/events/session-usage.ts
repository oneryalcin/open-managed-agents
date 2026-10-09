import type { ModelRequestCostRecord, PersistedSessionEvent } from "./types.ts";

// Plan 0148: session usage. Token totals are summed from the public span ends
// in the store; this module holds what is computed outside SQL: the cost Pi
// reports per model request, and active time from the status events.

/** What a span end's public `model_usage` lacks, from Pi's `message_end`. */
export interface ModelRequestCost {
  /** Null when the request used tokens but Pi had no price for its model. */
  costMicros: number | null;
  cacheWrite1hTokens: number;
  provider: string | null;
  modelId: string | null;
}

export function modelRequestCost(piEvent: unknown): ModelRequestCost | undefined {
  if (!isObject(piEvent) || piEvent.type !== "message_end") return undefined;
  const message = piEvent.message;
  if (!isObject(message) || message.role !== "assistant" || !isObject(message.usage)) {
    return undefined;
  }
  const usage = message.usage;
  const tokens = count(usage.input) + count(usage.output) + count(usage.cacheRead) +
    count(usage.cacheWrite);
  const total = isObject(usage.cost) ? usage.cost.total : undefined;
  const priced = typeof total === "number" && Number.isFinite(total) && total > 0;
  return {
    // Decided here, from Pi's float: a tiny request can round to 0 micros.
    costMicros: priced ? Math.round(total * 1_000_000) : tokens > 0 ? null : 0,
    cacheWrite1hTokens: count(usage.cacheWrite1h),
    provider: typeof message.provider === "string" ? message.provider : null,
    modelId: typeof message.model === "string" ? message.model : null,
  };
}

/**
 * Active time from status events in append order, `[isRunning, time]`:
 * running opens an interval if none is open; any other status (idle with any
 * stop reason, so requires_action waits do not count; rescheduled;
 * terminated) closes it. The same rules as the session_usage_totals triggers;
 * used to backfill them.
 */
export function activeTimeState(
  events: ReadonlyArray<readonly [boolean, string]>,
): { activeMs: number; runningSince: string | null } {
  let activeMs = 0;
  let runningSince: string | null = null;
  for (const [running, at] of events) {
    if (running) {
      runningSince ??= at;
    } else if (runningSince !== null) {
      // An unreadable time adds nothing rather than failing the backfill.
      const ms = Date.parse(at) - Date.parse(runningSince);
      if (Number.isFinite(ms)) activeMs += Math.max(0, ms);
      runningSince = null;
    }
  }
  return { activeMs, runningSince };
}

/** Seconds active up to `until`, counting an interval still open. */
export function activeSeconds(
  totals: { activeMs: number; runningSince: string | null },
  until: Date,
): number {
  const open = totals.runningSince === null
    ? 0
    : Math.max(0, until.getTime() - Date.parse(totals.runningSince));
  return (totals.activeMs + open) / 1000;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The cost change for the span end among `rows`, from the Pi `message_end`
 * that produced it. Empty when the batch has no span end.
 */
export function modelRequestCostChanges(
  rows: readonly Pick<PersistedSessionEvent, "id" | "workspace_id" | "session_id" | "type">[],
  piMessageEnd: unknown,
  now: string,
): ModelRequestCostRecord[] {
  const spanEnd = rows.find((row) => row.type === "span.model_request_end");
  const cost = spanEnd === undefined ? undefined : modelRequestCost(piMessageEnd);
  if (spanEnd === undefined || cost === undefined) return [];
  return [{
    workspaceId: spanEnd.workspace_id,
    sessionId: spanEnd.session_id,
    spanEventId: spanEnd.id,
    ...cost,
    now,
  }];
}
