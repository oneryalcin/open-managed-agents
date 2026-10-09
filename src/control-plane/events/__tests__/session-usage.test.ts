import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { EventStore } from "../store.ts";
import { activeSeconds, modelRequestCost } from "../session-usage.ts";
import type { PersistedSessionEvent } from "../types.ts";

// Plan 0148: session usage = the public span ends' tokens plus the cost Pi
// reported for each request, and active time from the status events.

const WS = "wrk_default";
const SESSION = "sesn_usage";
let seq = 0;

function spanEnd(usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): PersistedSessionEvent {
  seq += 1;
  const now = new Date().toISOString();
  return {
    id: `sevt_usage_${String(seq).padStart(4, "0")}`,
    workspace_id: WS,
    session_id: SESSION,
    type: "span.model_request_end",
    processed_at: now,
    created_at: now,
    payload: {
      model_request_start_id: "sevt_start",
      is_error: false,
      model_usage: {
        input_tokens: usage.input ?? 0,
        output_tokens: usage.output ?? 0,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        cache_creation_input_tokens: usage.cacheWrite ?? 0,
        speed: null,
      },
    },
  };
}

function priced(event: PersistedSessionEvent, costMicros: number | null, cacheWrite1h = 0) {
  return {
    workspaceId: WS,
    sessionId: SESSION,
    spanEventId: event.id,
    costMicros,
    cacheWrite1hTokens: cacheWrite1h,
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    now: event.created_at,
  };
}

function usage(store: EventStore) {
  return store.sessionUsage(WS, [SESSION]).get(SESSION);
}

describe("session model usage (store)", () => {
  it("adds up the tokens of the session's span ends", () => {
    const store = EventStore.open(":memory:");
    store.appendBatchWithRuntimeChanges(
      [spanEnd({ input: 2, output: 54, cacheWrite: 16600 }), spanEnd({ input: 2, output: 4, cacheRead: 16600, cacheWrite: 61 })],
      {},
    );

    expect(usage(store)).toMatchObject({
      inputTokens: 4,
      outputTokens: 58,
      cacheReadTokens: 16600,
      cacheWriteTokens: 16661,
    });
  });

  it("adds up the cost recorded with each span end", () => {
    const store = EventStore.open(":memory:");
    const a = spanEnd({ input: 2, output: 54 });
    const b = spanEnd({ input: 2, output: 4 });
    store.appendBatchWithRuntimeChanges([a, b], {
      modelRequestCosts: [priced(a, 41_500), priced(b, 4_400)],
    });

    expect(usage(store)?.costMicros).toBe(45_900);
  });

  it("reports no cost when a request with tokens has no recorded cost", () => {
    // An unpriced model, or a span written by an OMA without cost tracking.
    const store = EventStore.open(":memory:");
    const a = spanEnd({ input: 2, output: 54 });
    const b = spanEnd({ input: 2, output: 4 });
    store.appendBatchWithRuntimeChanges([a, b], { modelRequestCosts: [priced(a, 41_500)] });

    expect(usage(store)?.costMicros).toBeNull();
  });

  it("reports no cost when a request's recorded cost is unknown", () => {
    const store = EventStore.open(":memory:");
    const a = spanEnd({ input: 2, output: 54 });
    store.appendBatchWithRuntimeChanges([a], { modelRequestCosts: [priced(a, null)] });

    expect(usage(store)?.costMicros).toBeNull();
  });

  it("counts a zero-token span end as free, not unknown", () => {
    // Synthetic span ends from interrupts and terminalization (D4).
    const store = EventStore.open(":memory:");
    const a = spanEnd({ input: 2, output: 54 });
    store.appendBatchWithRuntimeChanges([a, spanEnd({})], { modelRequestCosts: [priced(a, 41_500)] });

    expect(usage(store)?.costMicros).toBe(41_500);
  });

  it("adds up the 1-hour cache writes", () => {
    const store = EventStore.open(":memory:");
    const a = spanEnd({ cacheWrite: 900 });
    store.appendBatchWithRuntimeChanges([a], { modelRequestCosts: [priced(a, 10, 600)] });

    expect(usage(store)?.cacheWrite1hTokens).toBe(600);
  });

  it("removes a deleted session's recorded costs", () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-usage-"));
    try {
      const path = join(dir, "events.sqlite");
      const store = EventStore.open(path);
      const a = spanEnd({ input: 2, output: 54 });
      store.appendBatchWithRuntimeChanges([a], { modelRequestCosts: [priced(a, 41_500)] });

      store.deleteForSession(WS, SESSION);

      const raw = new DatabaseSync(path);
      const left = raw.prepare(
        `SELECT (SELECT COUNT(*) FROM session_model_request_costs)
              + (SELECT COUNT(*) FROM session_usage_totals) AS n`,
      ).get() as { n: number };
      raw.close();
      expect(left.n).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function status(type: string, second: number): PersistedSessionEvent {
  seq += 1;
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  return {
    id: `sevt_status_${String(seq).padStart(4, "0")}`,
    workspace_id: WS,
    session_id: SESSION,
    type: `session.status_${type}` as PersistedSessionEvent["type"],
    processed_at: at,
    created_at: at,
    payload: {},
  };
}

describe("active seconds (store)", () => {
  const at60 = new Date(Date.UTC(2026, 0, 1, 0, 1, 0));
  const active = (statuses: Array<[string, number]>) => {
    const store = EventStore.open(":memory:");
    store.appendBatchWithRuntimeChanges(statuses.map(([type, second]) => status(type, second)), {});
    return activeSeconds(usage(store)!, at60);
  };

  it("counts running until idle", () => {
    expect(active([["running", 0], ["idle", 10]])).toBe(10);
  });

  it("does not count a requires_action wait or a repeated running", () => {
    expect(active([["running", 0], ["idle", 10], ["running", 30], ["running", 31], ["idle", 35]])).toBe(15);
  });

  it("stops at termination when archived mid-run", () => {
    expect(active([["running", 0], ["terminated", 5]])).toBe(5);
  });

  it("stops during a retry backoff", () => {
    expect(active([["running", 0], ["rescheduled", 4], ["running", 10], ["idle", 12]])).toBe(6);
  });

  it("counts a turn still running up to now", () => {
    expect(active([["idle", 0], ["running", 50]])).toBe(10);
  });

  it("never rejects a status event over an unreadable time", () => {
    // Metering must not be able to fail the event write it observes.
    const store = EventStore.open(":memory:");
    const bad = { ...status("idle", 0), created_at: "not-a-time" };

    expect(() =>
      store.appendBatchWithRuntimeChanges([status("running", 0), bad], {}),
    ).not.toThrow();
  });

  it("ignores an idle with no running before it", () => {
    expect(active([["idle", 5], ["running", 20], ["idle", 25]])).toBe(5);
  });
});

describe("usage totals across versions", () => {
  function withFile(run: (path: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "oma-usage-"));
    try {
      run(join(dir, "events.sqlite"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const insertRaw = (path: string, event: PersistedSessionEvent) => {
    const raw = new DatabaseSync(path);
    raw.prepare(
      `INSERT INTO events (id, workspace_id, session_id, type, processed_at, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(event.id, WS, SESSION, event.type, event.processed_at, JSON.stringify(event.payload), event.created_at);
    raw.close();
  };

  it("counts span ends written by an older OMA straight into the database", () => {
    // A rollback: the older version appends events without knowing the totals.
    withFile((path) => {
      EventStore.open(path);
      insertRaw(path, spanEnd({ input: 2, output: 54 }));

      expect(usage(EventStore.open(path))?.outputTokens).toBe(54);
    });
  });

  it("backfills totals for history written before they existed", () => {
    withFile((path) => {
      const store = EventStore.open(path);
      store.appendBatchWithRuntimeChanges(
        [status("running", 0), spanEnd({ input: 2, output: 54 }), status("idle", 10)],
        {},
      );
      const raw = new DatabaseSync(path);
      raw.exec("DROP TABLE session_usage_totals");
      raw.close();

      const reopened = usage(EventStore.open(path));

      expect([reopened?.outputTokens, reopened?.activeMs]).toEqual([54, 10_000]);
    });
  });

  it("forgets a session's usage when an older OMA deletes its events", () => {
    // A rollback: the older version deletes events without knowing the totals.
    withFile((path) => {
      const store = EventStore.open(path);
      const a = spanEnd({ input: 2, output: 54 });
      store.appendBatchWithRuntimeChanges([a], { modelRequestCosts: [priced(a, 41_500)] });
      const raw = new DatabaseSync(path);
      raw.prepare("DELETE FROM events WHERE workspace_id = ? AND session_id = ?").run(WS, SESSION);
      const left = raw.prepare(
        `SELECT (SELECT COUNT(*) FROM session_model_request_costs)
              + (SELECT COUNT(*) FROM session_usage_totals) AS n`,
      ).get() as { n: number };
      raw.close();

      expect(left.n).toBe(0);
    });
  });

  it("counts a search call once, even with two successful results for it", () => {
    const store = EventStore.open(":memory:");
    const now = new Date().toISOString();
    const event = (id: string, type: PersistedSessionEvent["type"], payload: PersistedSessionEvent["payload"]): PersistedSessionEvent => ({
      id, workspace_id: WS, session_id: SESSION, type, processed_at: now, created_at: now, payload,
    });
    store.appendBatchWithRuntimeChanges([
      event("sevt_use_dup", "agent.tool_use", { name: "web_search", input: { query: "q" } }),
      event("sevt_res_1", "agent.tool_result", { tool_use_id: "sevt_use_dup", is_error: false, content: "[]" }),
      event("sevt_res_2", "agent.tool_result", { tool_use_id: "sevt_use_dup", is_error: false, content: "[]" }),
    ], {});

    expect(usage(store)?.webSearchRequests).toBe(1);
  });

  it("adds and backfills the web search count on a database from before it existed", () => {
    withFile((path) => {
      const store = EventStore.open(path);
      const now = new Date().toISOString();
      const use: PersistedSessionEvent = {
        id: "sevt_use_search", workspace_id: WS, session_id: SESSION, type: "agent.tool_use",
        processed_at: now, created_at: now, payload: { name: "web_search", input: { query: "q" } },
      };
      const result: PersistedSessionEvent = {
        id: "sevt_result_search", workspace_id: WS, session_id: SESSION, type: "agent.tool_result",
        processed_at: now, created_at: now, payload: { tool_use_id: "sevt_use_search", is_error: false, content: "[]" },
      };
      store.appendBatchWithRuntimeChanges([use, result], {});
      const raw = new DatabaseSync(path);
      // The older schema: no counting trigger, no column.
      raw.exec("DROP TRIGGER session_usage_web_search");
      raw.exec("ALTER TABLE session_usage_totals DROP COLUMN web_search_requests");
      raw.close();

      expect(usage(EventStore.open(path))?.webSearchRequests).toBe(1);
    });
  });

  it("does not let a zero-token request's $0 stand in for a missing cost", () => {
    const store = EventStore.open(":memory:");
    const free = spanEnd({});
    store.appendBatchWithRuntimeChanges([spanEnd({ input: 2, output: 54 }), free], {
      modelRequestCosts: [priced(free, 0)],
    });

    expect(usage(store)?.costMicros).toBeNull();
  });
});

describe("model request cost from Pi's message_end", () => {
  const messageEnd = (usage: Record<string, unknown>) => ({
    type: "message_end",
    message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-5", usage },
  });

  it("converts Pi's dollar cost to micro-dollars", () => {
    const cost = modelRequestCost(
      messageEnd({ input: 2, output: 54, cacheRead: 0, cacheWrite: 16600, cost: { total: 0.041504 } }),
    );

    expect(cost?.costMicros).toBe(41_504);
  });

  it("marks a request with tokens but zero cost as unpriced", () => {
    // Pi reports zero rates for custom and local models.
    const cost = modelRequestCost(messageEnd({ input: 10, output: 5, cost: { total: 0 } }));

    expect(cost?.costMicros).toBeNull();
  });

  it("marks a request whose cost is not a number as unpriced", () => {
    // A custom model declaring only tiered rates yields NaN.
    const cost = modelRequestCost(messageEnd({ input: 10, output: 5, cost: { total: Number.NaN } }));

    expect(cost?.costMicros).toBeNull();
  });

  it("records the 1-hour share of cache writes", () => {
    const cost = modelRequestCost(
      messageEnd({ input: 1, output: 1, cacheWrite: 900, cacheWrite1h: 600, cost: { total: 0.01 } }),
    );

    expect(cost?.cacheWrite1hTokens).toBe(600);
  });
});
