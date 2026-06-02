/**
 * SessionEventBroadcaster — replay-then-tail fanout over a session's event log.
 *
 * On publish: persist via EventStore, then push to any live subscribers on this
 * session (persist-before-publish, ADR 0007 Pattern 2).
 *
 * On subscribe: register a live-event listener BEFORE replaying durable history,
 * buffer live events while replay runs, dedupe by event ID on drain, then yield
 * live events until aborted (replay-then-tail, ADR 0007 Pattern 1). Replay is
 * paginated; live queue is bounded — on overflow we drop the queue and re-drain
 * from the store via cursor. Mirrors Flue's bounded-buffer + refetch shape.
 *
 * Race we're guarding against:
 *   t0: subscriber arrives with lastSeenId X
 *   t1: subscriber registers live listener
 *   t2: a new event Y is published (lands in live queue)
 *   t3: store.list() reads — may include Y, may not, depending on timing
 * Without buffering live events during replay and dedup-on-drain, Y is either
 * delivered twice or not at all.
 *
 * Overflow recovery: if the live queue exceeds MAX_BUFFER while the subscriber
 * is suspended (slow consumer / long replay), we drop the buffer and re-drain
 * from store starting after the last-yielded ID. This bounds memory usage at
 * MAX_BUFFER events per subscription regardless of publish rate.
 */

import type { EventStore } from "./store.ts";
import type { PersistedSessionEvent } from "./types.ts";
import type { WorkspaceId } from "../workspace.ts";

interface Subscriber {
  push(event: PersistedSessionEvent): void;
  close(): void;
}

export interface SubscribeOptions {
  /** Resume cursor. If set, replay starts from events with `id > lastSeenId`. */
  lastSeenId?: string;
  /** Caller-controlled cancellation. */
  signal?: AbortSignal;
  /** Page size for store-drain. Default 500. */
  pageSize?: number;
  /** Max live-queue length before triggering overflow → refetch from store. Default 10000. */
  maxBuffer?: number;
}

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_BUFFER = 10_000;

export class SessionEventBroadcaster {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  constructor(private readonly store: EventStore) {}

  /**
   * Fan out already-persisted events to live subscribers for their sessions.
   *
   * IMPORTANT: this method does not persist. Callers that need durability must
   * persist first (e.g. `appendBatch`) before notifying.
   */
  publishPersisted(events: readonly PersistedSessionEvent[]): void {
    for (const event of events) {
      const subs = this.subscribers.get(subscriptionKey(event.workspace_id, event.session_id));
      if (!subs) continue;
      for (const sub of subs) {
        sub.push(event);
      }
    }
  }

  closeSession(workspaceId: WorkspaceId, sessionId: string): void {
    const subs = this.subscribers.get(subscriptionKey(workspaceId, sessionId));
    if (!subs) return;
    for (const sub of subs) {
      sub.close();
    }
  }

  /**
   * AsyncIterable yielding events for `sessionId` in stable ID order, deduped.
   * Replays history with `id > lastSeenId` via paginated cursor, then tails
   * live events until the supplied signal aborts.
   */
  async *subscribe(
    workspaceId: WorkspaceId,
    sessionId: string,
    opts: SubscribeOptions = {},
  ): AsyncIterable<PersistedSessionEvent> {
    const pageSize = positiveIntegerOrThrow(
      opts.pageSize ?? DEFAULT_PAGE_SIZE,
      "pageSize",
    );
    const maxBuffer = positiveIntegerOrThrow(
      opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
      "maxBuffer",
    );

    const liveQueue: PersistedSessionEvent[] = [];
    let overflowed = false;
    let closed = false;
    let wake: (() => void) | null = null;

    const wakeSubscriber = () => {
      if (!wake) return;
      const w = wake;
      wake = null;
      w();
    };

    const sub: Subscriber = {
      push(event) {
        if (overflowed) {
          // Already overflowed; drop. Will recover via store-drain.
          return;
        }
        liveQueue.push(event);
        if (liveQueue.length > maxBuffer) {
          // Drop the entire buffer; we'll refetch from the store using the
          // last-yielded ID as the cursor. This bounds memory at maxBuffer.
          overflowed = true;
          liveQueue.length = 0;
        }
        wakeSubscriber();
      },
      close() {
        closed = true;
        wakeSubscriber();
      },
    };

    // CRITICAL: register live listener BEFORE replaying. Any event published
    // during replay lands in liveQueue (or trips overflow); dedup by
    // `id <= lastYieldedId` handles the overlap.
    this.addSubscriber(workspaceId, sessionId, sub);

    const onAbort = () => {
      wakeSubscriber();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    let lastYieldedId: string | undefined = opts.lastSeenId;
    const aborted = () => opts.signal?.aborted ?? false;

    /**
     * Drain the store from current `lastYieldedId` to end, yielding each event.
     * Paginated — keeps loading pages until a partial page (or empty) tells us
     * we've caught up.
     */
    const store = this.store;
    function* drainStore(): Generator<PersistedSessionEvent> {
      while (true) {
        const page = store.list(workspaceId, sessionId, {
          afterId: lastYieldedId,
          limit: pageSize,
        });
        if (page.length === 0) return;
        for (const event of page) {
          yield event;
        }
        if (page.length < pageSize) return;
      }
    }

    try {
      // 1. Initial replay (paginated).
      for (const event of drainStore()) {
        if (aborted()) return;
        lastYieldedId = event.id;
        yield event;
      }

      // 2. Drain live + tail with overflow recovery.
      while (true) {
        if (aborted()) return;

        // Handle overflow: drop buffer, re-drain from store.
        if (overflowed) {
          overflowed = false;
          liveQueue.length = 0;
          for (const event of drainStore()) {
            if (aborted()) return;
            // dedup-by-cursor: drainStore already starts after lastYieldedId,
            // so every event is new.
            lastYieldedId = event.id;
            yield event;
          }
          continue;
        }

        // Drain whatever's currently in the live queue.
        while (liveQueue.length > 0) {
          if (aborted()) return;
          if (overflowed) break; // race: overflow happened during this drain
          const event = liveQueue.shift()!;
          // Dedup against the cursor — anything we've already yielded has
          // id <= lastYieldedId.
          if (lastYieldedId !== undefined && event.id <= lastYieldedId) {
            continue;
          }
          lastYieldedId = event.id;
          yield event;
        }

        if (overflowed) continue; // re-enter overflow handler
        if (aborted()) return;
        if (closed) return;

        // Sleep until next event or abort.
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      this.removeSubscriber(workspaceId, sessionId, sub);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** For tests/introspection. Not part of the public broadcaster contract. */
  subscriberCount(sessionId: string, workspaceId: WorkspaceId = "wrk_default"): number {
    return this.subscribers.get(subscriptionKey(workspaceId, sessionId))?.size ?? 0;
  }

  private addSubscriber(
    workspaceId: WorkspaceId,
    sessionId: string,
    sub: Subscriber,
  ): void {
    const key = subscriptionKey(workspaceId, sessionId);
    let set = this.subscribers.get(key);
    if (!set) {
      set = new Set();
      this.subscribers.set(key, set);
    }
    set.add(sub);
  }

  private removeSubscriber(
    workspaceId: WorkspaceId,
    sessionId: string,
    sub: Subscriber,
  ): void {
    const key = subscriptionKey(workspaceId, sessionId);
    const set = this.subscribers.get(key);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) this.subscribers.delete(key);
  }
}

function subscriptionKey(workspaceId: WorkspaceId, sessionId: string): string {
  return JSON.stringify([workspaceId, sessionId]);
}

function positiveIntegerOrThrow(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}
