import type { WorkspaceId } from "../workspace.ts";
import { sessionScopeKey } from "./session-guards.ts";

/**
 * Per-session waiting-room bookkeeping for runtime actions that pause a turn
 * pending an external result — custom-tool calls and tool confirmations each
 * kept a byte-identical copy of this add/remove/clear/has logic on
 * `DefaultSessionEventsService` (#164, plan 0123 Slice 1).
 *
 * The flush is intentionally cross-store: one coalesced `requires_action`
 * event spans BOTH stores, so the flush callback is injected and stays in the
 * service (see `flushPendingActions` / `snapshotForFlush`). This class owns only
 * one store's map mechanics and per-session timer handle.
 */
export class PendingActionStore {
  private readonly entries = new Map<
    string,
    {
      workspaceId: WorkspaceId;
      ids: string[];
      timer: ReturnType<typeof setTimeout> | undefined;
    }
  >();

  constructor(
    private readonly scheduleFlush: (
      workspaceId: WorkspaceId,
      sessionId: string,
    ) => void,
  ) {}

  add(workspaceId: WorkspaceId, sessionId: string, id: string): void {
    const key = sessionScopeKey(workspaceId, sessionId);
    let pending = this.entries.get(key);
    if (!pending) {
      pending = { workspaceId, ids: [], timer: undefined };
      this.entries.set(key, pending);
    }
    pending.ids.push(id);
    if (pending.timer) return;
    // Pi may emit parallel tool calls back-to-back in one runtime burst. Defer
    // the idle by one macrotask so those calls coalesce into one
    // requires_action event. If another action arrives later, we re-emit
    // requires_action with the full remaining pending set.
    pending.timer = setTimeout(() => {
      this.scheduleFlush(pending.workspaceId, sessionId);
    }, 0);
  }

  remove(workspaceId: WorkspaceId, sessionId: string, id: string): void {
    const key = sessionScopeKey(workspaceId, sessionId);
    const pending = this.entries.get(key);
    if (!pending) return;
    pending.ids = pending.ids.filter((existing) => existing !== id);
    if (pending.ids.length === 0 && pending.timer === undefined) {
      this.entries.delete(key);
    }
  }

  clear(workspaceId: WorkspaceId, sessionId: string): string[] {
    const key = sessionScopeKey(workspaceId, sessionId);
    const pending = this.entries.get(key);
    if (!pending) return [];
    if (pending.timer) clearTimeout(pending.timer);
    this.entries.delete(key);
    return [...pending.ids];
  }

  has(workspaceId: WorkspaceId, sessionId: string): boolean {
    return (
      (this.entries.get(sessionScopeKey(workspaceId, sessionId))?.ids.length ??
        0) > 0
    );
  }

  /**
   * Cross-store flush helper: force-clear the timer, return a COPY of the
   * pending ids, and drop the entry only if it is now empty. It does NOT
   * consume the ids — they persist until resolved via `remove`, so a later
   * flush re-emits the full remaining pending set. The service merges the
   * returned ids from both stores into one coalesced `requires_action` event.
   */
  snapshotForFlush(workspaceId: WorkspaceId, sessionId: string): string[] {
    const key = sessionScopeKey(workspaceId, sessionId);
    const pending = this.entries.get(key);
    if (!pending) return [];
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    const ids = [...pending.ids];
    if (pending.ids.length === 0) {
      this.entries.delete(key);
    }
    return ids;
  }
}
