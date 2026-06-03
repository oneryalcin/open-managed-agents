/**
 * EventStore — durable append-only event log backed by SQLite.
 *
 * Persist-before-publish (ADR 0007 Pattern 2): every event hits this table
 * before being broadcast to live subscribers. Subscribers that miss the live
 * broadcast (drop, reconnect, never-connected) recover via `list()`.
 *
 * Uses `node:sqlite` (built-in to Node 22.5+) so we have no native dependency
 * that would break under the `ignore-scripts=true` npm policy.
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { EventType } from "../../types/events.ts";
import type { JsonObject } from "../../types/json.ts";
import { RuntimeTurnOwnershipLostError } from "./types.ts";
import type {
  EventStoreRuntimeChanges,
  ListSessionEventRecordsOptions,
  PendingRuntimeActionRecord,
  PendingRuntimeTurnRecord,
  PersistedSessionEvent,
  RuntimeTurnRecoveryClaim,
  SessionEventRecordPage,
  SessionEventStore,
} from "./types.ts";
import type { WorkspaceId } from "../workspace.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'wrk_default',
  session_id   TEXT NOT NULL,
  type         TEXT NOT NULL,
  processed_at TEXT,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_runtime_turns (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  lease_expires_at TEXT NOT NULL,
  state TEXT NOT NULL,
  trigger_event_ids TEXT NOT NULL,
  open_model_request_start_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  terminalized_at TEXT,
  PRIMARY KEY (workspace_id, session_id, turn_id)
);
CREATE TABLE IF NOT EXISTS pending_runtime_actions (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  state TEXT NOT NULL,
  acknowledged_at TEXT,
  closed_at TEXT,
  close_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, session_id, action_id),
  FOREIGN KEY (workspace_id, session_id, turn_id)
    REFERENCES pending_runtime_turns(workspace_id, session_id, turn_id)
);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS events_by_workspace_session ON events (workspace_id, session_id, id);
CREATE INDEX IF NOT EXISTS events_by_workspace_session_type ON events (workspace_id, session_id, type, id);
CREATE INDEX IF NOT EXISTS pending_runtime_actions_by_turn
  ON pending_runtime_actions (workspace_id, session_id, turn_id);
`;

interface EventRow {
  id: string;
  workspace_id: string;
  session_id: string;
  type: string;
  processed_at: string | null;
  payload: string;
  created_at: string;
}

interface RuntimeActionRow {
  workspace_id: string;
  session_id: string;
  turn_id: string;
  action_id: string;
  action_type: string;
  action_state: string;
  acknowledged_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
  action_created_at: string;
  action_updated_at: string;
  owner_id: string;
  owner_generation: number;
  lease_expires_at: string;
  turn_state: string;
  trigger_event_ids: string;
  open_model_request_start_ids: string;
  turn_created_at: string;
  turn_updated_at: string;
  completed_at: string | null;
  terminalized_at: string | null;
}

interface RuntimeTurnRow {
  workspace_id: string;
  session_id: string;
  turn_id: string;
  owner_id: string;
  owner_generation: number;
  lease_expires_at: string;
  state: string;
  trigger_event_ids: string;
  open_model_request_start_ids: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  terminalized_at: string | null;
}

export interface ListOptions {
  /** Legacy cursor alias — return events with `id > afterId` in ASC order. */
  afterId?: string;
  /** Cursor token from `next_page`. */
  page?: string;
  /**
   * Page size cap.
   * - Legacy `list()` default: 1000
   * - API-facing `listPage()` default: 20
   */
  limit?: number;
  /** Sort order. Defaults to `asc`. */
  order?: "asc" | "desc";
  /** Optional event type filter. */
  types?: readonly string[];
}

export class EventStore implements SessionEventStore {
  private readonly db: DatabaseSync;
  private readonly appendStmt: StatementSync;
  private readonly deleteForSessionStmt: StatementSync;
  private readonly deleteRuntimeActionsForSessionStmt: StatementSync;
  private readonly deleteRuntimeTurnsForSessionStmt: StatementSync;
  private readonly retrieveStmt: StatementSync;
  private readonly findRuntimeActionStmt: StatementSync;
  private readonly listPendingRuntimeTurnsStmt: StatementSync;
  private readonly listRuntimeActionsForTurnStmt: StatementSync;
  private readonly insertRuntimeTurnStmt: StatementSync;
  private readonly insertRuntimeActionStmt: StatementSync;
  private readonly acknowledgeRuntimeActionStmt: StatementSync;
  private readonly closeRuntimeActionStmt: StatementSync;
  private readonly updateRuntimeTurnStateStmt: StatementSync;
  private readonly renewRuntimeTurnLeaseStmt: StatementSync;
  private readonly updateRuntimeTurnOpenModelRequestStartsStmt: StatementSync;
  private readonly closeRuntimeTurnStmt: StatementSync;
  private readonly closeRuntimeActionsForTurnStmt: StatementSync;
  private readonly claimAcceptedRuntimeTurnStmt: StatementSync;
  private readonly claimTerminalizingRuntimeTurnStmt: StatementSync;
  private readonly retrieveRuntimeTurnStmt: StatementSync;
  private readonly listStmts = new Map<string, StatementSync>();

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
    ensureWorkspaceIdColumn(this.db);
    ensureOpenModelRequestStartIdsColumn(this.db);
    this.db.exec(INDEXES);
    this.appendStmt = this.db.prepare(
      `INSERT INTO events (id, workspace_id, session_id, type, processed_at, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.deleteForSessionStmt = this.db.prepare(
      `DELETE FROM events WHERE workspace_id = ? AND session_id = ?`,
    );
    this.deleteRuntimeActionsForSessionStmt = this.db.prepare(
      `DELETE FROM pending_runtime_actions
       WHERE workspace_id = ? AND session_id = ?`,
    );
    this.deleteRuntimeTurnsForSessionStmt = this.db.prepare(
      `DELETE FROM pending_runtime_turns
       WHERE workspace_id = ? AND session_id = ?`,
    );
    this.retrieveStmt = this.db.prepare(
      `SELECT id, workspace_id, session_id, type, processed_at, payload, created_at
       FROM events WHERE workspace_id = ? AND id = ?`,
    );
    this.findRuntimeActionStmt = this.db.prepare(runtimeActionSelectSql(`
      WHERE a.workspace_id = ? AND a.session_id = ? AND a.action_id = ?
      LIMIT 1
    `));
    this.listPendingRuntimeTurnsStmt = this.db.prepare(
      `SELECT workspace_id, session_id, turn_id, owner_id, owner_generation,
              lease_expires_at, state, trigger_event_ids, created_at, updated_at,
              completed_at, terminalized_at, open_model_request_start_ids
       FROM pending_runtime_turns
       WHERE workspace_id = ? AND state NOT IN ('completed', 'terminalized')
       ORDER BY turn_id ASC`,
    );
    this.listRuntimeActionsForTurnStmt = this.db.prepare(runtimeActionSelectSql(`
      WHERE a.workspace_id = ? AND a.session_id = ? AND a.turn_id = ?
      ORDER BY a.action_id ASC
    `));
    this.insertRuntimeTurnStmt = this.db.prepare(
      `INSERT INTO pending_runtime_turns
        (workspace_id, session_id, turn_id, owner_id, owner_generation,
         lease_expires_at, state, trigger_event_ids, open_model_request_start_ids,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, '[]', ?, ?)`,
    );
    this.insertRuntimeActionStmt = this.db.prepare(
      `INSERT INTO pending_runtime_actions
        (workspace_id, session_id, turn_id, action_id, action_type, state,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    );
    this.acknowledgeRuntimeActionStmt = this.db.prepare(
      `UPDATE pending_runtime_actions
       SET state = 'acknowledged',
           acknowledged_at = COALESCE(acknowledged_at, ?),
           updated_at = ?
       WHERE workspace_id = ? AND session_id = ? AND action_id = ?
         AND state = 'pending'`,
    );
    this.closeRuntimeActionStmt = this.db.prepare(
      `UPDATE pending_runtime_actions
       SET state = 'closed',
           closed_at = COALESCE(closed_at, ?),
           close_reason = COALESCE(close_reason, ?),
           updated_at = ?
       WHERE workspace_id = ? AND session_id = ? AND action_id = ?
         AND state != 'closed'`,
    );
    this.updateRuntimeTurnStateStmt = this.db.prepare(
      `UPDATE pending_runtime_turns
       SET state = ?,
           lease_expires_at = COALESCE(?, lease_expires_at),
           updated_at = ?
       WHERE workspace_id = ? AND session_id = ? AND turn_id = ?
         AND state NOT IN ('completed', 'terminalized')
         AND (? IS NULL OR (owner_id = ? AND owner_generation = ?))`,
    );
    this.renewRuntimeTurnLeaseStmt = this.db.prepare(
      `UPDATE pending_runtime_turns
       SET lease_expires_at = ?, updated_at = ?
       WHERE workspace_id = ? AND session_id = ? AND turn_id = ?
         AND state NOT IN ('completed', 'terminalized')
         AND owner_id = ? AND owner_generation = ?`,
    );
    this.updateRuntimeTurnOpenModelRequestStartsStmt = this.db.prepare(
      `UPDATE pending_runtime_turns
       SET open_model_request_start_ids = ?, updated_at = ?
       WHERE workspace_id = ? AND session_id = ? AND turn_id = ?
         AND state NOT IN ('completed', 'terminalized')
         AND owner_id = ? AND owner_generation = ?`,
    );
    this.closeRuntimeTurnStmt = this.db.prepare(
      `UPDATE pending_runtime_turns
       SET state = ?,
           updated_at = ?,
           open_model_request_start_ids = '[]',
           completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, ?) ELSE completed_at END,
           terminalized_at = CASE WHEN ? = 'terminalized' THEN COALESCE(terminalized_at, ?) ELSE terminalized_at END
       WHERE workspace_id = ? AND session_id = ? AND turn_id = ?
         AND state NOT IN ('completed', 'terminalized')
         AND (? IS NULL OR (owner_id = ? AND owner_generation = ?))`,
    );
    this.closeRuntimeActionsForTurnStmt = this.db.prepare(
      `UPDATE pending_runtime_actions
       SET state = 'closed',
           closed_at = COALESCE(closed_at, ?),
           close_reason = COALESCE(close_reason, ?),
           updated_at = ?
       WHERE workspace_id = ? AND session_id = ? AND turn_id = ?
         AND state != 'closed'`,
    );
    this.claimAcceptedRuntimeTurnStmt = this.db.prepare(
      `UPDATE pending_runtime_turns
       SET owner_id = ?,
           owner_generation = owner_generation + 1,
           lease_expires_at = ?,
           state = 'dispatching',
           updated_at = ?
       WHERE workspace_id = ? AND session_id = ? AND turn_id = ?
         AND state = 'accepted'
         AND (owner_id = ? OR lease_expires_at <= ?)`,
    );
    this.claimTerminalizingRuntimeTurnStmt = this.db.prepare(
      `UPDATE pending_runtime_turns
       SET owner_id = ?,
           owner_generation = owner_generation + 1,
           lease_expires_at = ?,
           state = 'terminalizing',
           updated_at = ?
       WHERE workspace_id = ? AND session_id = ? AND turn_id = ?
         AND state NOT IN ('completed', 'terminalized')
         AND (owner_id = ? OR lease_expires_at <= ?)`,
    );
    this.retrieveRuntimeTurnStmt = this.db.prepare(
      `SELECT workspace_id, session_id, turn_id, owner_id, owner_generation,
              lease_expires_at, state, trigger_event_ids, created_at, updated_at,
              completed_at, terminalized_at, open_model_request_start_ids
       FROM pending_runtime_turns
       WHERE workspace_id = ? AND session_id = ? AND turn_id = ?`,
    );
  }

  /** Open a store backed by a SQLite file. Pass `:memory:` for in-memory. */
  static open(path = ":memory:"): EventStore {
    return new EventStore(new DatabaseSync(path));
  }

  append(event: PersistedSessionEvent): void {
    this.appendEvent(event);
  }

  appendBatch(events: readonly PersistedSessionEvent[]): void {
    this.appendBatchWithRuntimeChanges(events, {});
  }

  appendBatchWithRuntimeChanges(
    events: readonly PersistedSessionEvent[],
    changes: EventStoreRuntimeChanges,
  ): void {
    this.db.exec("BEGIN");
    try {
      for (const event of events) {
        this.appendEvent(event);
      }
      this.applyRuntimeChanges(changes);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteForSession(workspaceId: WorkspaceId, sessionId: string): void {
    this.db.exec("BEGIN");
    try {
      this.deleteRuntimeActionsForSessionStmt.run(workspaceId, sessionId);
      this.deleteRuntimeTurnsForSessionStmt.run(workspaceId, sessionId);
      this.deleteForSessionStmt.run(workspaceId, sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list(
    workspaceId: WorkspaceId,
    sessionId: string,
    opts: ListOptions = {},
  ): PersistedSessionEvent[] {
    return this.listPage(workspaceId, sessionId, {
      ...opts,
      limit: opts.limit ?? 1000,
    }).data;
  }

  listPage(
    workspaceId: WorkspaceId,
    sessionId: string,
    opts: ListSessionEventRecordsOptions = {},
  ): SessionEventRecordPage {
    const cursor = resolveCursor(opts);
    if (cursor === "") {
      return { data: [], next_page: null };
    }
    const order = resolveOrder(opts);
    const limit = normalizeLimit(opts.limit);
    const stmt = this.listStmt({
      hasCursor: cursor !== undefined,
      order,
      types: opts.types ?? [],
    });
    const rows = stmt.all(...selectListArgs(workspaceId, sessionId, cursor, limit + 1, opts.types)) as unknown as EventRow[];
    const data = rows.slice(0, limit).map(deserialize);
    return {
      data,
      next_page: rows.length > limit ? data[data.length - 1]?.id ?? null : null,
    };
  }

  retrieve(workspaceId: WorkspaceId, id: string): PersistedSessionEvent | undefined {
    const row = this.retrieveStmt.get(workspaceId, id) as unknown as EventRow | undefined;
    return row ? deserialize(row) : undefined;
  }

  findRuntimeAction(
    workspaceId: WorkspaceId,
    sessionId: string,
    actionId: string,
  ): PendingRuntimeActionRecord | undefined {
    const row = this.findRuntimeActionStmt.get(
      workspaceId,
      sessionId,
      actionId,
    ) as unknown as RuntimeActionRow | undefined;
    return row ? deserializeRuntimeAction(row) : undefined;
  }

  listPendingRuntimeTurns(workspaceId: WorkspaceId): PendingRuntimeTurnRecord[] {
    const rows = this.listPendingRuntimeTurnsStmt.all(
      workspaceId,
    ) as unknown as RuntimeTurnRow[];
    return rows.map(deserializeRuntimeTurn);
  }

  claimAcceptedRuntimeTurnForRecovery(
    claim: RuntimeTurnRecoveryClaim,
  ): PendingRuntimeTurnRecord | undefined {
    const result = this.claimAcceptedRuntimeTurnStmt.run(
      claim.ownerId,
      claim.leaseExpiresAt,
      claim.now,
      claim.workspaceId,
      claim.sessionId,
      claim.turnId,
      claim.ownerId,
      claim.now,
    );
    if (result.changes === 0) return undefined;
    return this.retrieveRuntimeTurn(
      claim.workspaceId,
      claim.sessionId,
      claim.turnId,
    );
  }

  claimRuntimeTurnForTerminalization(
    claim: RuntimeTurnRecoveryClaim,
  ): PendingRuntimeTurnRecord | undefined {
    const result = this.claimTerminalizingRuntimeTurnStmt.run(
      claim.ownerId,
      claim.leaseExpiresAt,
      claim.now,
      claim.workspaceId,
      claim.sessionId,
      claim.turnId,
      claim.ownerId,
      claim.now,
    );
    if (result.changes === 0) return undefined;
    return this.retrieveRuntimeTurn(
      claim.workspaceId,
      claim.sessionId,
      claim.turnId,
    );
  }

  listRuntimeActionsForTurn(
    workspaceId: WorkspaceId,
    sessionId: string,
    turnId: string,
  ): PendingRuntimeActionRecord[] {
    const rows = this.listRuntimeActionsForTurnStmt.all(
      workspaceId,
      sessionId,
      turnId,
    ) as unknown as RuntimeActionRow[];
    return rows.map(deserializeRuntimeAction);
  }

  private retrieveRuntimeTurn(
    workspaceId: WorkspaceId,
    sessionId: string,
    turnId: string,
  ): PendingRuntimeTurnRecord | undefined {
    const row = this.retrieveRuntimeTurnStmt.get(
      workspaceId,
      sessionId,
      turnId,
    ) as unknown as RuntimeTurnRow | undefined;
    return row ? deserializeRuntimeTurn(row) : undefined;
  }

  close(): void {
    this.db.close();
  }

  private appendEvent(event: PersistedSessionEvent): void {
    this.appendStmt.run(
      event.id,
      event.workspace_id,
      event.session_id,
      event.type,
      event.processed_at,
      JSON.stringify(event.payload),
      event.created_at,
    );
  }

  private applyRuntimeChanges(changes: EventStoreRuntimeChanges): void {
    for (const turn of changes.acceptedTurns ?? []) {
      this.insertRuntimeTurnStmt.run(
        turn.workspaceId,
        turn.sessionId,
        turn.turnId,
        turn.ownerId,
        turn.ownerGeneration,
        turn.leaseExpiresAt,
        JSON.stringify([...turn.triggerEventIds]),
        turn.now,
        turn.now,
      );
    }
    for (const action of changes.openedActions ?? []) {
      this.insertRuntimeActionStmt.run(
        action.workspaceId,
        action.sessionId,
        action.turnId,
        action.actionId,
        action.actionType,
        action.now,
        action.now,
      );
    }
    for (const action of changes.acknowledgedActions ?? []) {
      this.acknowledgeRuntimeActionStmt.run(
        action.now,
        action.now,
        action.workspaceId,
        action.sessionId,
        action.actionId,
      );
    }
    for (const action of changes.closedActions ?? []) {
      this.closeRuntimeActionStmt.run(
        action.now,
        action.reason,
        action.now,
        action.workspaceId,
        action.sessionId,
        action.actionId,
      );
    }
    for (const turn of changes.turnStates ?? []) {
      const result = this.updateRuntimeTurnStateStmt.run(
        turn.state,
        turn.leaseExpiresAt ?? null,
        turn.now,
        turn.workspaceId,
        turn.sessionId,
        turn.turnId,
        turn.ownerId ?? null,
        turn.ownerId ?? null,
        turn.ownerGeneration ?? null,
      );
      if (turn.ownerId !== undefined && result.changes === 0) {
        throw new RuntimeTurnOwnershipLostError(turn.turnId);
      }
    }
    for (const turn of changes.leaseRenewals ?? []) {
      const result = this.renewRuntimeTurnLeaseStmt.run(
        turn.leaseExpiresAt,
        turn.now,
        turn.workspaceId,
        turn.sessionId,
        turn.turnId,
        turn.ownerId,
        turn.ownerGeneration,
      );
      if (result.changes === 0) {
        throw new RuntimeTurnOwnershipLostError(turn.turnId);
      }
    }
    for (const turn of changes.openedModelRequestStarts ?? []) {
      this.updateRuntimeTurnOpenModelRequestStarts(turn, (current) => [
        ...current,
        turn.startEventId,
      ]);
    }
    for (const turn of changes.closedModelRequestStarts ?? []) {
      this.updateRuntimeTurnOpenModelRequestStarts(turn, (current) => {
        const index = current.lastIndexOf(turn.startEventId);
        return index === -1
          ? current
          : [...current.slice(0, index), ...current.slice(index + 1)];
      });
    }
    for (const turn of changes.closedTurns ?? []) {
      const result = this.closeRuntimeTurnStmt.run(
        turn.state,
        turn.now,
        turn.state,
        turn.now,
        turn.state,
        turn.now,
        turn.workspaceId,
        turn.sessionId,
        turn.turnId,
        turn.ownerId ?? null,
        turn.ownerId ?? null,
        turn.ownerGeneration ?? null,
      );
      if (turn.ownerId !== undefined && result.changes === 0) {
        throw new RuntimeTurnOwnershipLostError(turn.turnId);
      }
      this.closeRuntimeActionsForTurnStmt.run(
        turn.now,
        turn.reason,
        turn.now,
        turn.workspaceId,
        turn.sessionId,
        turn.turnId,
      );
    }
  }

  private updateRuntimeTurnOpenModelRequestStarts(
    turn: {
      workspaceId: WorkspaceId;
      sessionId: string;
      turnId: string;
      ownerId: string;
      ownerGeneration: number;
      now: string;
    },
    update: (current: readonly string[]) => readonly string[],
  ): void {
    const existing = this.retrieveRuntimeTurn(
      turn.workspaceId,
      turn.sessionId,
      turn.turnId,
    );
    const current = existing?.open_model_request_start_ids ?? [];
    const next = update(current);
    const result = this.updateRuntimeTurnOpenModelRequestStartsStmt.run(
      JSON.stringify(next),
      turn.now,
      turn.workspaceId,
      turn.sessionId,
      turn.turnId,
      turn.ownerId,
      turn.ownerGeneration,
    );
    if (result.changes === 0) {
      throw new RuntimeTurnOwnershipLostError(turn.turnId);
    }
  }

  private listStmt(opts: {
    hasCursor: boolean;
    order: "asc" | "desc";
    types: readonly string[];
  }): StatementSync {
    const key = JSON.stringify({
      hasCursor: opts.hasCursor,
      order: opts.order,
      typeCount: opts.types.length,
    });
    const existing = this.listStmts.get(key);
    if (existing) return existing;

    const predicates = ["workspace_id = ?", "session_id = ?"];
    if (opts.types.length > 0) {
      predicates.push(`type IN (${opts.types.map(() => "?").join(", ")})`);
    }
    if (opts.hasCursor) {
      predicates.push(opts.order === "asc" ? "id > ?" : "id < ?");
    }
    const stmt = this.db.prepare(
      `SELECT id, workspace_id, session_id, type, processed_at, payload, created_at
       FROM events
       WHERE ${predicates.join(" AND ")}
       ORDER BY id ${opts.order.toUpperCase()}
       LIMIT ?`,
    );
    this.listStmts.set(key, stmt);
    return stmt;
  }
}

function selectListArgs(
  workspaceId: WorkspaceId,
  sessionId: string,
  cursor: string | undefined,
  limit: number,
  types: readonly string[] | undefined,
):
  | [WorkspaceId, string, number]
  | [WorkspaceId, string, ...string[], number]
  | [WorkspaceId, string, string, number]
  | [WorkspaceId, string, ...string[], string, number] {
  const t = types ?? [];
  if (cursor === undefined) {
    return t.length === 0
      ? [workspaceId, sessionId, limit]
      : [workspaceId, sessionId, ...t, limit];
  }
  return t.length === 0
    ? [workspaceId, sessionId, cursor, limit]
    : [workspaceId, sessionId, ...t, cursor, limit];
}

function resolveCursor(opts: ListSessionEventRecordsOptions): string | undefined {
  return opts.page ?? opts.afterId;
}

function resolveOrder(opts: ListSessionEventRecordsOptions): "asc" | "desc" {
  if (opts.afterId !== undefined && opts.order === undefined) {
    return "asc";
  }
  return opts.order ?? "asc";
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isSafeInteger(limit) || limit <= 0) return 20;
  return Math.min(limit, 1000);
}

function deserialize(row: EventRow): PersistedSessionEvent {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    session_id: row.session_id,
    type: row.type as EventType,
    processed_at: row.processed_at,
    payload: JSON.parse(row.payload) as JsonObject,
    created_at: row.created_at,
  };
}

function runtimeActionSelectSql(whereClause: string): string {
  return `
    SELECT
      a.workspace_id,
      a.session_id,
      a.turn_id,
      a.action_id,
      a.action_type,
      a.state AS action_state,
      a.acknowledged_at,
      a.closed_at,
      a.close_reason,
      a.created_at AS action_created_at,
      a.updated_at AS action_updated_at,
      t.owner_id,
      t.owner_generation,
      t.lease_expires_at,
      t.state AS turn_state,
      t.trigger_event_ids,
      t.open_model_request_start_ids,
      t.created_at AS turn_created_at,
      t.updated_at AS turn_updated_at,
      t.completed_at,
      t.terminalized_at
    FROM pending_runtime_actions a
    JOIN pending_runtime_turns t
      ON t.workspace_id = a.workspace_id
     AND t.session_id = a.session_id
     AND t.turn_id = a.turn_id
    ${whereClause}
  `;
}

function deserializeRuntimeAction(row: RuntimeActionRow): PendingRuntimeActionRecord {
  return {
    workspace_id: row.workspace_id,
    session_id: row.session_id,
    turn_id: row.turn_id,
    action_id: row.action_id,
    action_type: row.action_type as PendingRuntimeActionRecord["action_type"],
    state: row.action_state as PendingRuntimeActionRecord["state"],
    acknowledged_at: row.acknowledged_at,
    closed_at: row.closed_at,
    close_reason:
      row.close_reason as PendingRuntimeActionRecord["close_reason"],
    created_at: row.action_created_at,
    updated_at: row.action_updated_at,
    turn: {
      workspace_id: row.workspace_id,
      session_id: row.session_id,
      turn_id: row.turn_id,
      owner_id: row.owner_id,
      owner_generation: row.owner_generation,
      lease_expires_at: row.lease_expires_at,
      state: row.turn_state as PendingRuntimeTurnRecord["state"],
      trigger_event_ids: parseTriggerEventIds(row.trigger_event_ids),
      open_model_request_start_ids: parseStringArray(
        row.open_model_request_start_ids,
      ),
      created_at: row.turn_created_at,
      updated_at: row.turn_updated_at,
      completed_at: row.completed_at,
      terminalized_at: row.terminalized_at,
    },
  };
}

function deserializeRuntimeTurn(row: RuntimeTurnRow): PendingRuntimeTurnRecord {
  return {
    workspace_id: row.workspace_id,
    session_id: row.session_id,
    turn_id: row.turn_id,
    owner_id: row.owner_id,
    owner_generation: row.owner_generation,
    lease_expires_at: row.lease_expires_at,
    state: row.state as PendingRuntimeTurnRecord["state"],
    trigger_event_ids: parseTriggerEventIds(row.trigger_event_ids),
    open_model_request_start_ids: parseStringArray(
      row.open_model_request_start_ids,
    ),
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    terminalized_at: row.terminalized_at,
  };
}

function parseTriggerEventIds(value: string): string[] {
  return parseStringArray(value);
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
    ? parsed
    : [];
}

function ensureWorkspaceIdColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(events)").all() as Array<{
    name: string;
  }>;
  if (columns.some((column) => column.name === "workspace_id")) return;
  const existing = db.prepare("SELECT COUNT(*) AS count FROM events").get() as {
    count: number;
  };
  db.exec("BEGIN");
  try {
    db.exec(
      "ALTER TABLE events ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'wrk_default'",
    );
    if (existing.count === 0) {
      db.exec("COMMIT");
      return;
    }
    if (hasTable(db, "sessions")) {
      db.exec(`
        UPDATE events
        SET workspace_id = (
          SELECT sessions.workspace_id
          FROM sessions
          WHERE sessions.id = events.session_id
        )
        WHERE EXISTS (
          SELECT 1 FROM sessions WHERE sessions.id = events.session_id
        )
      `);
      const unmapped = db.prepare(`
        SELECT COUNT(*) AS count
        FROM events
        WHERE NOT EXISTS (
          SELECT 1 FROM sessions WHERE sessions.id = events.session_id
        )
      `).get() as { count: number };
      if (unmapped.count === 0) {
        db.exec("COMMIT");
        return;
      }
    }
    throw new Error(
      "Cannot automatically migrate legacy events without workspace_id; run an explicit workspace backfill first.",
    );
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function ensureOpenModelRequestStartIdsColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(pending_runtime_turns)").all() as Array<{
    name: string;
  }>;
  if (
    columns.some((column) => column.name === "open_model_request_start_ids")
  ) {
    return;
  }
  db.exec(
    "ALTER TABLE pending_runtime_turns ADD COLUMN open_model_request_start_ids TEXT NOT NULL DEFAULT '[]'",
  );
}

function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}
