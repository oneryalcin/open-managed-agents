import { describe, expect, it } from "vitest";
import { createBestEffortRuntimeEventCoordinator } from "../deployment-runtime-event-coordinator.ts";
import { SessionEventBroadcaster } from "../events/broadcaster.ts";
import { DefaultSessionEventsService } from "../events/service.ts";
import { EventStore } from "../events/store.ts";
import {
  RuntimeTurnOwnershipLostError,
  type EventStoreRuntimeChanges,
  type PersistedSessionEvent,
  type RuntimeEventRunner,
} from "../events/types.ts";
import { PiSessionRunner } from "../sessions/pi/runner.ts";
import { translatePiEvent } from "../sessions/pi/translator.ts";
import { SqliteSessionStore } from "../sessions/store.ts";
import { createRealPi, type RealPi } from "../sessions/pi/__tests__/real-pi.ts";

// Plan 0147 slice 2: the conversation is saved once per settled turn, in the
// turn-close transaction. Real Pi with its faux model provider.
const WS = "wrk_default";

async function harness(opts: {
  wrapStore?: (store: EventStore) => EventStore;
  runner?: RuntimeEventRunner;
} = {}) {
  const pi = await createRealPi();
  const realStore = EventStore.open(":memory:");
  const eventStore = opts.wrapStore ? opts.wrapStore(realStore) : realStore;
  const sessionStore = SqliteSessionStore.open(":memory:");
  const runner =
    opts.runner ?? new PiSessionRunner({ sessionFactory: pi.sessionFactory, idleTtlMs: 0 });
  const service = new DefaultSessionEventsService(
    eventStore,
    sessionStore,
    new SessionEventBroadcaster(eventStore),
    {
      runner,
      translate: translatePiEvent,
      runtimeEventCoordinator: createBestEffortRuntimeEventCoordinator({
        sessions: sessionStore,
        events: eventStore,
      }),
    },
  );
  const sessionId = `sesn_${Math.random().toString(16).slice(2)}`;
  const now = new Date().toISOString();
  sessionStore.create({
    row: {
      id: sessionId,
      workspace_id: WS,
      type: "session",
      agent: { type: "agent", id: "agent_conv", version: 1 },
      environment_id: "env_conv",
      status: "idle",
      title: null,
      metadata: {},
      created_at: now,
      updated_at: now,
      archived_at: null,
      usage: null,
      resources: [],
    },
  });
  const send = (text: string) =>
    service.send(WS, sessionId, {
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    });
  const idles = () =>
    realStore.list(WS, sessionId).filter((event) => event.type === "session.status_idle").length;
  // "role:text" for each stored message entry, in order.
  const stored = () =>
    realStore.listConversationEntries(WS, sessionId).flatMap((row) => {
      const entry = JSON.parse(row.json) as {
        type: string;
        message?: { role: string; content: unknown };
      };
      if (entry.type !== "message" || !entry.message) return [];
      return [`${entry.message.role}:${textOf(entry.message.content)}`];
    });
  return { pi, service, runner, realStore, sessionId, send, idles, stored };
}

describe("conversation checkpoint per settled turn", () => {
  it("saves the turn's conversation when it settles", async () => {
    const h = await harness();
    h.pi.core.setResponses([h.pi.faux.fauxAssistantMessage("hello back")]);

    h.send("hello");
    await waitFor(() => h.stored().length === 2);

    expect(h.stored()).toEqual(["user:hello", "assistant:hello back"]);
  });

  it("saves nothing while the turn is still running", async () => {
    const h = await harness();
    const gate = deferred<void>();
    h.pi.core.setResponses([
      async () => {
        await gate.promise;
        return h.pi.faux.fauxAssistantMessage("done");
      },
    ]);

    h.send("work");
    await waitFor(() => h.pi.core.state.callCount === 1);
    const midTurn = h.stored();
    gate.resolve();
    await waitFor(() => h.stored().length === 2);

    expect(midTurn).toEqual([]);
  });

  it("includes a message steered into the running turn", async () => {
    const h = await harness();
    const gate = deferred<void>();
    h.pi.core.setResponses([
      async () => {
        await gate.promise;
        return h.pi.faux.fauxAssistantMessage("first reply");
      },
      h.pi.faux.fauxAssistantMessage("steered reply"),
    ]);

    h.send("first");
    await waitFor(() => h.pi.core.state.callCount === 1);
    h.send("steered");
    gate.resolve();
    await waitFor(() => h.stored().length === 4);

    expect(h.stored()).toEqual([
      "user:first",
      "assistant:first reply",
      "user:steered",
      "assistant:steered reply",
    ]);
  });

  it("saves the checkpoint alone when the close fails but the turn is still this owner's", async () => {
    // Models an interrupt that already closed the turn: the completed close
    // throws, and the checkpoint is written on its own, fenced on ownership.
    let rejectCloses = 1;
    const h = await harness({ wrapStore: rejectingCheckpointWrites(() => rejectCloses-- > 0, "close") });
    h.pi.core.setResponses([h.pi.faux.fauxAssistantMessage("one")]);

    h.send("first");
    await waitFor(() => h.stored().length === 2);

    expect(h.stored()).toEqual(["user:first", "assistant:one"]);
  });

  it("offers entries again on the next settled turn when a stale owner's checkpoint is refused", async () => {
    // Both the close and the checkpoint-only write are refused once.
    let rejections = 2;
    const h = await harness({ wrapStore: rejectingCheckpointWrites(() => rejections-- > 0, "any") });
    h.pi.core.setResponses([
      h.pi.faux.fauxAssistantMessage("one"),
      h.pi.faux.fauxAssistantMessage("two"),
    ]);

    h.send("first");
    await waitFor(() => h.idles() >= 1 && rejections <= 0);
    const afterRefusal = h.stored();
    h.send("second");
    await waitFor(() => h.stored().length === 4);

    expect({ afterRefusal, final: h.stored() }).toEqual({
      afterRefusal: [],
      final: ["user:first", "assistant:one", "user:second", "assistant:two"],
    });
  });

  it("keeps draining after this owner's interrupt closed the turn, then saves the settled conversation", async () => {
    // An interrupt with a pending tool action closes the turn before Pi
    // finishes aborting; later event writes fail the pending-only fence.
    const resume = deferred<void>();
    const released: boolean[] = [];
    const runner: RuntimeEventRunner = {
      async *runUserMessage() {
        yield { type: "agent_start" };
        await resume.promise;
        yield {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted" },
        };
        yield { type: "agent_end", messages: [] };
        yield {
          type: "oma.conversation_settled",
          entries: [{ entryId: "hdr", json: "{}" }, { entryId: "e1", json: "{}" }],
          piVersion: "0.85.1",
          // Idempotent, first call wins, as the runner's is.
          release: (committed: boolean) => {
            if (released.length === 0) released.push(committed);
          },
        };
      },
    };
    const h = await harness({ runner });

    h.send("work");
    await waitFor(() => h.realStore.listPendingRuntimeTurns(WS).some((turn) => turn.state === "running"));
    const turn = h.realStore.listPendingRuntimeTurns(WS)[0]!;
    h.realStore.appendBatchWithRuntimeChanges([], {
      closedTurns: [{
        workspaceId: WS,
        sessionId: h.sessionId,
        turnId: turn.turn_id,
        ownerId: turn.owner_id,
        ownerGeneration: turn.owner_generation,
        reason: "interrupted",
        state: "terminalized",
        now: new Date().toISOString(),
      }],
    });
    resume.resolve();
    await delay(100);

    expect({
      stored: h.realStore.listConversationEntries(WS, h.sessionId).map((row) => row.entryId),
      released,
    }).toEqual({ stored: ["hdr", "e1"], released: [true] });
  });

  it("saves nothing for a session archived before the turn settles", async () => {
    const h = await harness();
    const gate = deferred<void>();
    h.pi.core.setResponses([
      async () => {
        await gate.promise;
        return h.pi.faux.fauxAssistantMessage("late");
      },
    ]);

    h.send("work");
    await waitFor(() => h.pi.core.state.callCount === 1);
    // Archive aborts the run; the gated faux response ignores aborts.
    const archiving = h.service.archiveSession(WS, h.sessionId);
    gate.resolve();
    await archiving;
    await delay(50);

    expect(h.stored()).toEqual([]);
  });
});

// Refuses batches carrying a conversation checkpoint while `shouldReject()`
// says so: "close" only those that also close a turn, "any" every one.
function rejectingCheckpointWrites(shouldReject: () => boolean, which: "close" | "any") {
  return (store: EventStore): EventStore =>
    new Proxy(store, {
      get(target, prop, receiver) {
        if (prop !== "appendBatchWithRuntimeChanges") {
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (events: readonly PersistedSessionEvent[], changes: EventStoreRuntimeChanges) => {
          const hasCheckpoint = (changes.conversationCheckpoints?.length ?? 0) > 0;
          const closes = (changes.closedTurns?.length ?? 0) > 0;
          if (hasCheckpoint && (which === "any" || closes) && shouldReject()) {
            throw new RuntimeTurnOwnershipLostError("rtun_simulated");
          }
          return target.appendBatchWithRuntimeChanges(events, changes);
        };
      },
    });
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "object" && block !== null && "text" in block
        ? String((block as { text: unknown }).text)
        : "",
    )
    .join("");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await delay(5);
  }
}
