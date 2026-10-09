import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  idleTtlMs?: number;
  rebuildRecreatesWorkspace?: boolean;
  /** File-backed stores, to model a restart; a fresh session row is created only once. */
  paths?: { events: string; sessions: string; sessionId: string };
  pi?: RealPi;
} = {}) {
  const pi = opts.pi ?? await createRealPi();
  const realStore = EventStore.open(opts.paths?.events ?? ":memory:");
  const eventStore = opts.wrapStore ? opts.wrapStore(realStore) : realStore;
  const sessionStore = SqliteSessionStore.open(opts.paths?.sessions ?? ":memory:");
  const runner =
    opts.runner ??
    new PiSessionRunner({
      sessionFactory: pi.sessionFactory,
      idleTtlMs: opts.idleTtlMs ?? 0,
      conversation: realStore,
      rebuildRecreatesWorkspace: opts.rebuildRecreatesWorkspace ?? false,
    });
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
  const sessionId = opts.paths?.sessionId ?? `sesn_${Math.random().toString(16).slice(2)}`;
  const now = new Date().toISOString();
  if (!sessionStore.retrieve(WS, sessionId)) sessionStore.create({
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

/** The most recent model request's messages, as "role:text". */
function lastRequest(pi: RealPi): string[] {
  return pi.requests[pi.requests.length - 1] ?? [];
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

  it("releases without committing when a checkpoint is refused for an open turn", async () => {
    // A refusal on a turn that is still open is a genuine ownership loss:
    // the cursor must not advance (the runner re-offers the entries).
    const released: boolean[] = [];
    const runner: RuntimeEventRunner = {
      async *runUserMessage() {
        yield { type: "agent_start" };
        yield {
          type: "oma.conversation_settled",
          entries: [{ entryId: "hdr", json: "{}" }],
          turnIds: [],
          piVersion: "0.85.1",
          release: (committed: boolean) => {
            if (released.length === 0) released.push(committed);
          },
        };
      },
      async interruptSession() {},
    };
    let rejections = 1;
    const h = await harness({ runner, wrapStore: rejectingCheckpointWrites(() => rejections-- > 0, "any") });

    h.send("work");
    await waitFor(() => released.length === 1);

    expect({ released, stored: h.realStore.listConversationEntries(WS, h.sessionId) })
      .toEqual({ released: [false], stored: [] });
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
          turnIds: [],
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

  it("does not interrupt the session after saving an interrupted turn's conversation", async () => {
    // A newer turn may already be running when the interrupted one settles.
    const resume = deferred<void>();
    const interrupted: string[] = [];
    let settledReleased = false;
    const runner: RuntimeEventRunner = {
      async *runUserMessage() {
        yield { type: "agent_start" };
        await resume.promise;
        yield { type: "agent_end", messages: [] };
        yield {
          type: "oma.conversation_settled",
          entries: [{ entryId: "hdr", json: "{}" }],
          turnIds: [],
          piVersion: "0.85.1",
          release: () => {
            settledReleased = true;
          },
        };
      },
      async interruptSession(_workspaceId: string, sessionId: string) {
        interrupted.push(sessionId);
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
    await waitFor(() => settledReleased);
    await delay(50);

    expect(interrupted).toEqual([]);
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
describe("conversation rebuild (plan 0147 slice 3a)", () => {
  it("rebuilds the conversation after idle eviction", async () => {
    const h = await harness({ idleTtlMs: 20 });
    h.pi.core.setResponses([
      h.pi.faux.fauxAssistantMessage("Nice to meet you, Ada."),
      h.pi.faux.fauxAssistantMessage("Your name is Ada."),
    ]);
    h.send("My name is Ada.");
    await waitFor(() => h.stored().length === 2);
    await waitFor(() => (h.runner as unknown as { sessions: Map<string, unknown> }).sessions.size === 0);

    h.send("What is my name?");
    await waitFor(() => h.pi.core.state.callCount === 2);

    expect({ rebuilt: h.pi.created.count, request: lastRequest(h.pi) }).toEqual({
      rebuilt: 2,
      request: ["user:My name is Ada.", "assistant:Nice to meet you, Ada.", "user:What is my name?"],
    });
  });

  it("fails loudly when a rebuilt session does not contain its saved conversation", async () => {
    // A factory that ignores the seed would otherwise start with no memory and
    // silently skip every later checkpoint.
    const pi = await createRealPi();
    const ignoresSeed = { ...pi, sessionFactory: (ws: string, sid: string) => pi.sessionFactory(ws, sid, []) };
    const h = await harness({ idleTtlMs: 20, pi: ignoresSeed });
    h.pi.core.setResponses([h.pi.faux.fauxAssistantMessage("one")]);
    h.send("first");
    await waitFor(() => h.stored().length === 2);
    await waitFor(() => (h.runner as unknown as { sessions: Map<string, unknown> }).sessions.size === 0);

    h.send("second");
    await waitFor(() => h.realStore.list(WS, h.sessionId).some((event) => event.type === "session.error"));

    expect(h.pi.core.state.callCount).toBe(1);
  });

  it("rebuilds the conversation after a restart on durable stores", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-rebuild-"));
    try {
      const paths = {
        events: join(dir, "events.sqlite"),
        sessions: join(dir, "sessions.sqlite"),
        sessionId: "sesn_restart",
      };
      const before = await harness({ paths });
      before.pi.core.setResponses([before.pi.faux.fauxAssistantMessage("Noted: blue.")]);
      before.send("My favourite colour is blue.");
      await waitFor(() => before.stored().length === 2);

      const after = await harness({ paths }); // new runner, service and Pi
      after.pi.core.setResponses([after.pi.faux.fauxAssistantMessage("Blue.")]);
      after.send("What is my favourite colour?");
      await waitFor(() => after.pi.core.state.callCount === 1);

      expect(lastRequest(after.pi)).toEqual([
        "user:My favourite colour is blue.",
        "assistant:Noted: blue.",
        "user:What is my favourite colour?",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});

describe("continuity notes on rebuild (plan 0147 slice 3b)", () => {
  const evicted = (h: Awaited<ReturnType<typeof harness>>) =>
    (h.runner as unknown as { sessions: Map<string, unknown> }).sessions.size === 0;

  it("tells the model about a turn that was cut off before it settled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-unfinished-"));
    try {
      const paths = { events: join(dir, "e.sqlite"), sessions: join(dir, "s.sqlite"), sessionId: "sesn_cut" };
      const before = await harness({ paths });
      before.pi.core.setResponses([async () => new Promise(() => {})]); // never answers
      before.send("Deploy the app.");
      await waitFor(() => before.pi.core.state.callCount === 1);
      // Restart: recovery terminalizes the abandoned turn.
      const after = await harness({ paths });
      const turn = after.realStore.listPendingRuntimeTurns(WS)[0]!;
      after.realStore.appendBatchWithRuntimeChanges([], {
        closedTurns: [{
          workspaceId: WS, sessionId: paths.sessionId, turnId: turn.turn_id,
          ownerId: turn.owner_id, ownerGeneration: turn.owner_generation,
          reason: "terminalized", state: "terminalized", now: new Date().toISOString(),
        }],
      });
      after.pi.core.setResponses([after.pi.faux.fauxAssistantMessage("Checking.")]);

      after.send("Are you there?");
      await waitFor(() => after.pi.core.state.callCount === 1);

      expect(lastRequest(after.pi).find((m) => m.includes("did not finish"))).toContain("> Deploy the app.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tells the first message after a restart about a turn whose lease has not expired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-unfinished-"));
    try {
      const paths = { events: join(dir, "e.sqlite"), sessions: join(dir, "s.sqlite"), sessionId: "sesn_lease" };
      const before = await harness({ paths });
      before.pi.core.setResponses([async () => new Promise(() => {})]);
      before.send("Deploy the app.");
      await waitFor(() => before.pi.core.state.callCount === 1);
      const after = await harness({ paths });
      // As the app does at startup: the crashed turn's lease is still valid.
      after.service.recoverAllAbandonedRuntimeTurns({ takeOverPreviousOwners: true });
      after.pi.core.setResponses([after.pi.faux.fauxAssistantMessage("Checking.")]);

      after.send("Are you there?");
      await waitFor(() => after.pi.core.state.callCount === 1);

      expect(lastRequest(after.pi).find((m) => m.includes("did not finish"))).toContain("> Deploy the app.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not repeat a cut-off note on later rebuilds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-unfinished-"));
    try {
      const paths = { events: join(dir, "e.sqlite"), sessions: join(dir, "s.sqlite"), sessionId: "sesn_once" };
      const before = await harness({ paths });
      before.pi.core.setResponses([async () => new Promise(() => {})]);
      before.send("Deploy the app.");
      await waitFor(() => before.pi.core.state.callCount === 1);
      const after = await harness({ paths, idleTtlMs: 20 });
      const turn = after.realStore.listPendingRuntimeTurns(WS)[0]!;
      after.realStore.appendBatchWithRuntimeChanges([], {
        closedTurns: [{
          workspaceId: WS, sessionId: paths.sessionId, turnId: turn.turn_id,
          ownerId: turn.owner_id, ownerGeneration: turn.owner_generation,
          reason: "terminalized", state: "terminalized", now: new Date().toISOString(),
        }],
      });
      after.pi.core.setResponses([
        after.pi.faux.fauxAssistantMessage("Checking."),
        after.pi.faux.fauxAssistantMessage("Still here."),
      ]);
      after.send("Are you there?");
      await waitFor(() => after.stored().length >= 2);
      await waitFor(() => evicted(after));

      after.send("And now?");
      await waitFor(() => after.pi.core.state.callCount === 2);

      expect(lastRequest(after.pi).filter((m) => m.includes("did not finish"))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not report a message steered into a settled turn after a rebuild", async () => {
    const h = await harness({ idleTtlMs: 20 });
    const gate = deferred<void>();
    h.pi.core.setResponses([
      async () => {
        await gate.promise;
        return h.pi.faux.fauxAssistantMessage("first reply");
      },
      h.pi.faux.fauxAssistantMessage("steered reply"),
      h.pi.faux.fauxAssistantMessage("third reply"),
    ]);
    h.send("first");
    await waitFor(() => h.pi.core.state.callCount === 1);
    h.send("steered");
    gate.resolve();
    await waitFor(() => h.stored().length === 4);
    await waitFor(() => evicted(h));

    h.send("third");
    await waitFor(() => h.pi.core.state.callCount === 3);

    expect(lastRequest(h.pi).some((m) => m.includes("did not finish"))).toBe(false);
  });

  it("recovers from a server-side failure mid-turn and tells the model that turn did not finish", async () => {
    // A failure while the service persists the turn's events abandons the
    // runner mid-turn; the session must not wedge on the dead run.
    let failNext = true;
    const h = await harness({
      wrapStore: (store) =>
        new Proxy(store, {
          get(target, prop, receiver) {
            if (prop !== "appendBatchWithRuntimeChanges") {
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return (events: readonly PersistedSessionEvent[], changes: EventStoreRuntimeChanges) => {
              if (failNext && events.some((event) => event.type === "agent.message")) {
                failNext = false;
                throw new Error("disk full");
              }
              return target.appendBatchWithRuntimeChanges(events, changes);
            };
          },
        }),
    });
    h.pi.core.setResponses([
      h.pi.faux.fauxAssistantMessage("lost reply"),
      h.pi.faux.fauxAssistantMessage("ok"),
    ]);
    h.send("Deploy the app.");
    await waitFor(() => !failNext && h.idles() >= 1);

    h.send("Status?");
    await waitFor(() => h.pi.core.state.callCount === 2);

    expect(lastRequest(h.pi).find((m) => m.includes("did not finish"))).toContain("> Deploy the app.");
  });

  it("tells the model its sandbox was recreated when a rebuild gets a fresh workspace", async () => {
    const h = await harness({ idleTtlMs: 20, rebuildRecreatesWorkspace: true });
    h.pi.core.setResponses([
      h.pi.faux.fauxAssistantMessage("Wrote notes.txt."),
      h.pi.faux.fauxAssistantMessage("ok"),
    ]);
    h.send("Write notes.txt.");
    await waitFor(() => h.stored().length === 2);
    await waitFor(() => evicted(h));

    h.send("Read notes.txt.");
    await waitFor(() => h.pi.core.state.callCount === 2);

    expect(lastRequest(h.pi).some((m) => m.includes("sandbox was recreated"))).toBe(true);
  });

  it("says nothing about the sandbox when a rebuild keeps the workspace", async () => {
    const h = await harness({ idleTtlMs: 20, rebuildRecreatesWorkspace: false });
    h.pi.core.setResponses([
      h.pi.faux.fauxAssistantMessage("Wrote notes.txt."),
      h.pi.faux.fauxAssistantMessage("ok"),
    ]);
    h.send("Write notes.txt.");
    await waitFor(() => h.stored().length === 2);
    await waitFor(() => evicted(h));

    h.send("Read notes.txt.");
    await waitFor(() => h.pi.core.state.callCount === 2);

    expect(lastRequest(h.pi).some((m) => m.includes("sandbox was recreated"))).toBe(false);
  });
});

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
