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
  IdempotencyCompletionInput,
  IdempotencyReservationInput,
  IdempotencyReservationResult,
  ListSessionEventRecordsOptions,
  PendingRuntimeActionRecord,
  PendingRuntimeTurnRecord,
  PersistedSessionEvent,
  LoadedConversation,
  RuntimeConversationCheckpoint,
  RuntimeTurnRecoveryClaim,
  SessionEventRecordPage,
  SessionEventStore,
  SessionUsageTotals,
  StoredConversationEntry,
} from "./types.ts";
import type { RequestIdempotencyKey } from "../request-idempotency.ts";
import type { ManagedAgentsContentBlock } from "../../types/events.ts";
import { unfinishedUserMessages } from "./conversation-coverage.ts";
import { migrateEventStore } from "./store-schema.ts";
import { withSqliteTransaction } from "../sqlite-transaction.ts";
import type { WorkspaceId } from "../workspace.ts";
import type { ManagedAgentsSessionStatus } from "../../types/sessions.ts";

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

interface IdempotencyKeyRow {
  workspace_id: string;
  method: string;
  concrete_path: string;
  idempotency_key: string;
  route_label: string;
  fingerprint_sha256: string;
  status: string;
  response_status: number | null;
  response_body: string | null;
  resource_type: string | null;
  resource_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
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
  private readonly turnOwnedByStmt: StatementSync;
  private readonly turnClosedByStmt: StatementSync;
  private readonly turnsForSessionStmt: StatementSync;
  private readonly userMessagesForSessionStmt: StatementSync;
  private readonly insertConversationEntryStmt: StatementSync;
  private readonly listConversationEntriesStmt: StatementSync;
  private readonly latestSessionStatusStmt: StatementSync;
  private readonly insertModelRequestCostStmt: StatementSync;
  private readonly sessionUsageStmt: StatementSync;
  private readonly deleteConversationForSessionStmt: StatementSync;
  private readonly insertConversationTurnStmt: StatementSync;
  private readonly conversationTurnsStmt: StatementSync;
  private readonly deleteConversationTurnsForSessionStmt: StatementSync;
  private readonly deleteIdempotencyKeysForSessionStmt: StatementSync;
  private readonly deleteRuntimeActionsForSessionStmt: StatementSync;
  private readonly deleteRuntimeTurnsForSessionStmt: StatementSync;
  private readonly retrieveStmt: StatementSync;
  private readonly findRuntimeActionStmt: StatementSync;
  private readonly listPendingRuntimeTurnsStmt: StatementSync;
  private readonly listWorkspacesWithPendingRuntimeTurnsStmt: StatementSync;
  private readonly countPendingRuntimeTurnsStmt: StatementSync;
  private readonly countAllPendingRuntimeTurnsStmt: StatementSync;
  private runtimeChangesObserver?: (changes: EventStoreRuntimeChanges) => void;
  private readonly pendingRuntimeChangeObservations: EventStoreRuntimeChanges[] = [];
  private txDepth = 0;
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
  private readonly adoptPausedRuntimeTurnStmt: StatementSync;
  private readonly claimAcceptedRuntimeTurnStmt: StatementSync;
  private readonly claimTerminalizingRuntimeTurnStmt: StatementSync;
  private readonly retrieveRuntimeTurnStmt: StatementSync;
  private readonly purgeExpiredIdempotencyKeysStmt: StatementSync;
  private readonly reserveIdempotencyKeyStmt: StatementSync;
  private readonly retrieveIdempotencyKeyStmt: StatementSync;
  private readonly acquireAbandonedIdempotencyKeyStmt: StatementSync;
  private readonly completeIdempotencyKeyStmt: StatementSync;
  private readonly releaseIdempotencyReservationStmt: StatementSync;
  private readonly refreshIdempotencyReservationStmt: StatementSync;
  private readonly deleteIdempotencyKeysForResourceStmt: StatementSync;
  private readonly listStmts = new Map<string, StatementSync>();

  constructor(db: DatabaseSync) {
    this.db = db;
    migrateEventStore(this.db);
    this.appendStmt = this.db.prepare(
      `INSERT INTO events (id, workspace_id, session_id, type, processed_at, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.deleteForSessionStmt = this.db.prepare(
      `DELETE FROM events WHERE workspace_id = ? AND session_id = ?`,
    );
    this.turnOwnedByStmt = this.db.prepare(
      `SELECT 1 FROM pending_runtime_turns
       WHERE workspace_id = ? AND session_id = ? AND turn_id = ?
         AND owner_id = ? AND owner_generation = ?`,
    );
    this.turnsForSessionStmt = this.db.prepare(
      `SELECT turn_id, state, trigger_event_ids, close_reason FROM pending_runtime_turns
       WHERE workspace_id = ? AND session_id = ?`,
    );
    this.userMessagesForSessionStmt = this.db.prepare(
      `SELECT id, payload FROM events
       WHERE workspace_id = ? AND session_id = ? AND type = 'user.message'
       ORDER BY id`,
    );
    this.turnClosedByStmt = this.db.prepare(
      `SELECT 1 FROM pending_runtime_turns
       WHERE workspace_id = ? AND session_id = ? AND turn_id = ?
         AND owner_id = ? AND owner_generation = ?
         AND state IN ('completed', 'terminalized')`,
    );
    // Idempotent on entry_id only: re-offering an already-saved entry is a
    // no-op and does not consume a seq. Any other constraint violation still
    // raises, so a durability write never drops a row silently.
    this.insertConversationEntryStmt = this.db.prepare(
      `INSERT INTO session_conversation_entries
         (workspace_id, session_id, seq, entry_id, entry_json, turn_id, pi_version, created_at)
       SELECT ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?
       FROM session_conversation_entries
       WHERE workspace_id = ? AND session_id = ?
       ON CONFLICT (workspace_id, session_id, entry_id) DO NOTHING`,
    );
    this.insertModelRequestCostStmt = this.db.prepare(
      `INSERT INTO session_model_request_costs
         (workspace_id, session_id, span_event_id, cost_micros, cache_write_1h_tokens,
          provider, model_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.sessionUsageStmt = this.db.prepare(
      `SELECT span_count, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, cache_write_1h_tokens, cost_micros,
              spans_with_tokens, priced_spans_with_tokens, active_ms, running_since,
              web_search_requests
       FROM session_usage_totals WHERE workspace_id = ? AND session_id = ?`,
    );
    this.latestSessionStatusStmt = this.db.prepare(
      `SELECT type FROM events
       WHERE workspace_id = ? AND session_id = ?
         AND type IN ('session.status_running', 'session.status_idle',
                      'session.status_rescheduled', 'session.status_terminated')
       ORDER BY rowid DESC LIMIT 1`,
    );
    this.listConversationEntriesStmt = this.db.prepare(
      `SELECT entry_id, entry_json, turn_id, pi_version
       FROM session_conversation_entries
       WHERE workspace_id = ? AND session_id = ?
       ORDER BY seq`,
    );
    this.deleteConversationForSessionStmt = this.db.prepare(
      `DELETE FROM session_conversation_entries WHERE workspace_id = ? AND session_id = ?`,
    );
    this.insertConversationTurnStmt = this.db.prepare(
      `INSERT INTO session_conversation_turns (workspace_id, session_id, turn_id)
       VALUES (?, ?, ?)
       ON CONFLICT (workspace_id, session_id, turn_id) DO NOTHING`,
    );
    this.conversationTurnsStmt = this.db.prepare(
      `SELECT turn_id FROM session_conversation_turns WHERE workspace_id = ? AND session_id = ?`,
    );
    this.deleteConversationTurnsForSessionStmt = this.db.prepare(
      `DELETE FROM session_conversation_turns WHERE workspace_id = ? AND session_id = ?`,
    );
    this.deleteIdempotencyKeysForSessionStmt = this.db.prepare(
      `DELETE FROM idempotency_keys
       WHERE workspace_id = ? AND concrete_path = ?`,
    );
    this.deleteIdempotencyKeysForResourceStmt = this.db.prepare(
      `DELETE FROM idempotency_keys
       WHERE workspace_id = ? AND resource_type = ? AND resource_id = ?`,
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
    this.listWorkspacesWithPendingRuntimeTurnsStmt = this.db.prepare(
      `SELECT DISTINCT workspace_id
       FROM pending_runtime_turns
       WHERE state NOT IN ('completed', 'terminalized')
       ORDER BY workspace_id ASC`,
    );
    this.countPendingRuntimeTurnsStmt = this.db.prepare(
      `SELECT COUNT(*) AS n FROM pending_runtime_turns
       WHERE workspace_id = ? AND state NOT IN ('completed', 'terminalized')`,
    );
    this.countAllPendingRuntimeTurnsStmt = this.db.prepare(
      `SELECT COUNT(*) AS n FROM pending_runtime_turns
       WHERE state NOT IN ('completed', 'terminalized')`,
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
           terminalized_at = CASE WHEN ? = 'terminalized' THEN COALESCE(terminalized_at, ?) ELSE terminalized_at END,
           close_reason = COALESCE(close_reason, ?)
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
         AND (owner_id = ? OR owner_id = ? OR lease_expires_at <= ?)`,
    );
    // Re-claiming a turn this owner is already terminalizing keeps its
    // generation, so one batch answering several of its waits shares a
    // single claim instead of fencing out its own close. Safe only while
    // claim -> close runs synchronously in one send (no await between them).
    this.claimTerminalizingRuntimeTurnStmt = this.db.prepare(
      `UPDATE pending_runtime_turns
       SET owner_generation = CASE
             WHEN state = 'terminalizing' AND owner_id = ?1 THEN owner_generation
             ELSE owner_generation + 1
           END,
           owner_id = ?1,
           lease_expires_at = ?,
           state = 'terminalizing',
           updated_at = ?
       WHERE workspace_id = ? AND session_id = ? AND turn_id = ?
         AND state NOT IN ('completed', 'terminalized')
         AND (owner_id = ? OR owner_id = ? OR lease_expires_at <= ?)`,
    );
    this.adoptPausedRuntimeTurnStmt = this.db.prepare(
      `UPDATE pending_runtime_turns
       SET owner_id = ?,
           owner_generation = owner_generation + 1,
           lease_expires_at = ?,
           updated_at = ?
       WHERE workspace_id = ? AND session_id = ? AND turn_id = ?
         AND state = 'paused'
         AND owner_id = ?`,
    );
    this.retrieveRuntimeTurnStmt = this.db.prepare(
      `SELECT workspace_id, session_id, turn_id, owner_id, owner_generation,
              lease_expires_at, state, trigger_event_ids, created_at, updated_at,
              completed_at, terminalized_at, open_model_request_start_ids
       FROM pending_runtime_turns
       WHERE workspace_id = ? AND session_id = ? AND turn_id = ?`,
    );
    this.purgeExpiredIdempotencyKeysStmt = this.db.prepare(
      `DELETE FROM idempotency_keys
       WHERE status IN ('completed', 'in_progress') AND expires_at <= ?`,
    );
    this.reserveIdempotencyKeyStmt = this.db.prepare(
      `INSERT INTO idempotency_keys
        (workspace_id, method, concrete_path, idempotency_key, route_label,
         fingerprint_sha256, status, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?)
       ON CONFLICT(workspace_id, method, concrete_path, idempotency_key) DO NOTHING`,
    );
    this.retrieveIdempotencyKeyStmt = this.db.prepare(
      `SELECT workspace_id, method, concrete_path, idempotency_key, route_label,
              fingerprint_sha256, status, response_status, response_body,
              resource_type, resource_id, created_at, updated_at, expires_at
       FROM idempotency_keys
       WHERE workspace_id = ? AND method = ? AND concrete_path = ?
         AND idempotency_key = ?`,
    );
    this.acquireAbandonedIdempotencyKeyStmt = this.db.prepare(
      `UPDATE idempotency_keys
       SET updated_at = ?, expires_at = ?
       WHERE workspace_id = ? AND method = ? AND concrete_path = ?
         AND idempotency_key = ? AND fingerprint_sha256 = ?
         AND status = 'in_progress' AND updated_at <= ?`,
    );
    this.completeIdempotencyKeyStmt = this.db.prepare(
      `UPDATE idempotency_keys
       SET status = 'completed',
           response_status = ?,
           response_body = ?,
           resource_type = ?,
           resource_id = ?,
           updated_at = ?,
           expires_at = ?
       WHERE workspace_id = ? AND method = ? AND concrete_path = ?
         AND idempotency_key = ? AND fingerprint_sha256 = ?
         AND status = 'in_progress'`,
    );
    this.releaseIdempotencyReservationStmt = this.db.prepare(
      `DELETE FROM idempotency_keys
       WHERE workspace_id = ? AND method = ? AND concrete_path = ?
         AND idempotency_key = ? AND fingerprint_sha256 = ?
         AND status = 'in_progress'`,
    );
    this.refreshIdempotencyReservationStmt = this.db.prepare(
      `UPDATE idempotency_keys
       SET updated_at = ?, expires_at = ?
       WHERE workspace_id = ? AND method = ? AND concrete_path = ?
         AND idempotency_key = ? AND fingerprint_sha256 = ?
         AND status = 'in_progress'`,
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
    this.withTransaction(() => {
      this.appendBatchWithRuntimeChangesInTransaction(events, changes);
    });
  }

  appendBatchWithRuntimeChangesAndCompleteIdempotency(
    events: readonly PersistedSessionEvent[],
    changes: EventStoreRuntimeChanges,
    completion: IdempotencyCompletionInput,
  ): void {
    this.withTransaction(() => {
      this.appendBatchWithRuntimeChangesInTransaction(events, changes);
      this.completeIdempotencyInTransaction(completion);
    });
  }

  appendBatchWithRuntimeChangesInTransaction(
    events: readonly PersistedSessionEvent[],
    changes: EventStoreRuntimeChanges,
  ): void {
    for (const event of events) {
      this.appendEvent(event);
    }
    this.applyRuntimeChanges(changes);
  }

  completeIdempotencyInTransaction(completion: IdempotencyCompletionInput): void {
    const result = this.completeIdempotencyKeyStmt.run(
      completion.responseStatus,
      JSON.stringify(completion.responseBody),
      completion.resourceType ?? null,
      completion.resourceId ?? null,
      completion.now,
      completion.expiresAt,
      completion.workspaceId,
      completion.method,
      completion.concretePath,
      completion.key,
      completion.fingerprintSha256,
    );
    if (result.changes === 0) {
      throw new Error("Idempotency key reservation was not active at completion");
    }
  }

  completeIdempotency(completion: IdempotencyCompletionInput): void {
    this.withTransaction(() => {
      this.completeIdempotencyInTransaction(completion);
    });
  }

  releaseIdempotencyReservation(
    input: RequestIdempotencyKey & { workspaceId: WorkspaceId },
  ): void {
    this.releaseIdempotencyReservationStmt.run(
      input.workspaceId,
      input.method,
      input.concretePath,
      input.key,
      input.fingerprintSha256,
    );
  }

  refreshIdempotencyReservation(
    input: RequestIdempotencyKey & {
      workspaceId: WorkspaceId;
      now: string;
      expiresAt: string;
    },
  ): void {
    this.refreshIdempotencyReservationStmt.run(
      input.now,
      input.expiresAt,
      input.workspaceId,
      input.method,
      input.concretePath,
      input.key,
      input.fingerprintSha256,
    );
  }

  reserveIdempotencyKey(
    input: IdempotencyReservationInput,
  ): IdempotencyReservationResult {
    // Policy lives here because this store owns the durable ledger rows. The
    // service currently passes a conservative five-minute abandoned threshold.
    // Reacquiring an abandoned in-progress row is safe because reservation
    // commits before the domain transaction; if the completed response did not
    // commit, the event/runtime side effect could not have committed either.
    this.purgeExpiredIdempotencyKeysStmt.run(input.now);
    const inserted = this.reserveIdempotencyKeyStmt.run(
      input.workspaceId,
      input.method,
      input.concretePath,
      input.key,
      input.routeLabel,
      input.fingerprintSha256,
      input.now,
      input.now,
      input.expiresAt,
    );
    if (inserted.changes === 1) return { kind: "reserved" };

    const row = this.retrieveIdempotencyKey(input);
    if (!row) return { kind: "reserved" };
    if (row.fingerprint_sha256 !== input.fingerprintSha256) {
      return { kind: "fingerprint_mismatch" };
    }
    if (row.status === "completed") {
      if (row.response_status === null || row.response_body === null) {
        throw new Error("Completed idempotency row is missing response data");
      }
      return {
        kind: "replay",
        responseStatus: row.response_status,
        responseBody: JSON.parse(row.response_body) as JsonObject,
      };
    }
    if (row.status === "in_progress") {
      const acquired = this.acquireAbandonedIdempotencyKeyStmt.run(
        input.now,
        input.expiresAt,
        input.workspaceId,
        input.method,
        input.concretePath,
        input.key,
        input.fingerprintSha256,
        input.abandonedBefore,
      );
      return acquired.changes === 1 ? { kind: "reserved" } : { kind: "in_progress" };
    }
    throw new Error(`Unknown idempotency key status: ${row.status}`);
  }

  deleteForSession(workspaceId: WorkspaceId, sessionId: string): void {
    this.withTransaction(() => {
      this.deleteRuntimeActionsForSessionStmt.run(workspaceId, sessionId);
      this.deleteRuntimeTurnsForSessionStmt.run(workspaceId, sessionId);
      this.deleteForSessionStmt.run(workspaceId, sessionId);
      this.deleteConversationForSessionStmt.run(workspaceId, sessionId);
      this.deleteConversationTurnsForSessionStmt.run(workspaceId, sessionId);
      this.deleteIdempotencyKeysForSessionStmt.run(
        workspaceId,
        `/v1/sessions/${sessionId}/events`,
      );
      this.deleteIdempotencyKeysForResourceStmt.run(
        workspaceId,
        "session",
        sessionId,
      );
    });
  }

  withTransaction<T>(fn: () => T): T {
    this.txDepth += 1;
    try {
      return withSqliteTransaction(this.db, fn);
    } catch (error) {
      // This savepoint rolled back; the recorded changes never committed.
      // (Dropping ALL pending observations undercounts if a sibling nested
      // transaction already succeeded — the safe direction for a counter.)
      this.pendingRuntimeChangeObservations.length = 0;
      throw error;
    } finally {
      this.txDepth -= 1;
      if (this.txDepth === 0) this.flushRuntimeChangeObservations();
    }
  }

  // Post-commit observation seam for /metrics (plan 0121 §2): fires AFTER
  // the outermost store transaction releases, never inside it, so metrics
  // can't alter commit semantics. One seam covers every apply path — the
  // service's direct appends, persist.ts helpers, and both runtime-event
  // coordinators. Caveat (documented, accepted): when an EventStore
  // transaction is nested inside another store's savepoint on the same
  // connection, the observer fires before that OUTER commit — a rare
  // rollback there overcounts a turn; gauges self-correct from DB truth.
  setRuntimeChangesObserver(
    observer: (changes: EventStoreRuntimeChanges) => void,
  ): void {
    this.runtimeChangesObserver = observer;
  }

  private flushRuntimeChangeObservations(): void {
    if (this.pendingRuntimeChangeObservations.length === 0) return;
    const batches = this.pendingRuntimeChangeObservations.splice(0);
    const observer = this.runtimeChangesObserver;
    if (observer === undefined) return;
    for (const changes of batches) {
      try {
        observer(changes);
      } catch {
        // Observers are telemetry; they must never fail a request.
      }
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

  countPendingRuntimeTurns(workspaceId: WorkspaceId): number {
    return (this.countPendingRuntimeTurnsStmt.get(workspaceId) as { n: number }).n;
  }

  // Unscoped, for the /metrics gauge (0121 C2). Bounded by in-flight work,
  // so no dedicated index is needed.
  countAllPendingRuntimeTurns(): number {
    return (this.countAllPendingRuntimeTurnsStmt.get() as { n: number }).n;
  }

  listWorkspaceIdsWithPendingRuntimeTurns(): WorkspaceId[] {
    const rows = this.listWorkspacesWithPendingRuntimeTurnsStmt.all() as unknown as {
      workspace_id: WorkspaceId;
    }[];
    return rows.map((row) => row.workspace_id);
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
      claim.takeOverOwnerId ?? null,
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
      claim.takeOverOwnerId ?? null,
      claim.now,
    );
    if (result.changes === 0) return undefined;
    return this.retrieveRuntimeTurn(
      claim.workspaceId,
      claim.sessionId,
      claim.turnId,
    );
  }

  adoptPausedRuntimeTurn(
    claim: RuntimeTurnRecoveryClaim & { takeOverOwnerId: string },
  ): boolean {
    return this.adoptPausedRuntimeTurnStmt.run(
      claim.ownerId,
      claim.leaseExpiresAt,
      claim.now,
      claim.workspaceId,
      claim.sessionId,
      claim.turnId,
      claim.takeOverOwnerId,
    ).changes > 0;
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

  private retrieveIdempotencyKey(
    input: Pick<
      IdempotencyReservationInput,
      "workspaceId" | "method" | "concretePath" | "key"
    >,
  ): IdempotencyKeyRow | undefined {
    return this.retrieveIdempotencyKeyStmt.get(
      input.workspaceId,
      input.method,
      input.concretePath,
      input.key,
    ) as unknown as IdempotencyKeyRow | undefined;
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
    if (
      this.runtimeChangesObserver !== undefined &&
      ((changes.acceptedTurns?.length ?? 0) > 0 ||
        (changes.closedTurns?.length ?? 0) > 0)
    ) {
      this.pendingRuntimeChangeObservations.push(changes);
    }
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
        turn.reason,
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
    for (const checkpoint of changes.conversationCheckpoints ?? []) {
      this.applyConversationCheckpoint(checkpoint);
    }
    for (const cost of changes.modelRequestCosts ?? []) {
      this.insertModelRequestCostStmt.run(
        cost.workspaceId,
        cost.sessionId,
        cost.spanEventId,
        cost.costMicros,
        cost.cacheWrite1hTokens,
        cost.provider,
        cost.modelId,
        cost.now,
      );
    }
  }

  isRuntimeTurnOwnedBy(fence: {
    workspaceId: WorkspaceId;
    sessionId: string;
    turnId: string;
    ownerId: string;
    ownerGeneration: number;
  }): boolean {
    return (
      this.turnOwnedByStmt.get(
        fence.workspaceId,
        fence.sessionId,
        fence.turnId,
        fence.ownerId,
        fence.ownerGeneration,
      ) !== undefined
    );
  }

  listEventsOfTypes(
    workspaceId: WorkspaceId,
    sessionId: string,
    types: readonly EventType[],
  ): PersistedSessionEvent[] {
    if (types.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, session_id, type, processed_at, payload, created_at
         FROM events
         WHERE workspace_id = ? AND session_id = ? AND type IN (${types.map(() => "?").join(", ")})
         ORDER BY rowid`,
      )
      .all(workspaceId, sessionId, ...types) as unknown as EventRow[];
    return rows.map(deserialize);
  }

  sessionUsage(
    workspaceId: WorkspaceId,
    sessionIds: readonly string[],
  ): Map<string, SessionUsageTotals> {
    const totals = new Map<string, SessionUsageTotals>();
    for (const sessionId of sessionIds) {
      const row = this.sessionUsageStmt.get(workspaceId, sessionId) as {
        span_count: number;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        cache_write_1h_tokens: number;
        cost_micros: number;
        spans_with_tokens: number;
        priced_spans_with_tokens: number;
        active_ms: number;
        running_since: string | null;
        web_search_requests: number;
      } | undefined;
      if (row === undefined) continue;
      totals.set(sessionId, {
        spanCount: row.span_count,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        cacheWrite1hTokens: row.cache_write_1h_tokens,
        costMicros: row.spans_with_tokens > row.priced_spans_with_tokens ? null : row.cost_micros,
        activeMs: row.active_ms,
        runningSince: row.running_since,
        webSearchRequests: row.web_search_requests,
      });
    }
    return totals;
  }

  latestSessionStatuses(
    workspaceId: WorkspaceId,
    sessionIds: readonly string[],
  ): Map<string, ManagedAgentsSessionStatus> {
    // Rowid, not the time-ordered id: a clock rewind across a restart can make
    // a later event's id sort first (#281). Accepted work reads idle until its
    // session.status_running, as on hosted (probe 70); counting accepted turns
    // as running would hide requires_action behind a queued batch message.
    const statuses = new Map<string, ManagedAgentsSessionStatus>();
    for (const sessionId of sessionIds) {
      const row = this.latestSessionStatusStmt.get(workspaceId, sessionId) as
        | { type: string }
        | undefined;
      const status = row === undefined ? undefined : STATUS_BY_EVENT_TYPE[row.type];
      if (status !== undefined) statuses.set(sessionId, status);
    }
    return statuses;
  }

  isRuntimeTurnClosedBy(fence: {
    workspaceId: WorkspaceId;
    sessionId: string;
    turnId: string;
    ownerId: string;
    ownerGeneration: number;
  }): boolean {
    return (
      this.turnClosedByStmt.get(
        fence.workspaceId,
        fence.sessionId,
        fence.turnId,
        fence.ownerId,
        fence.ownerGeneration,
      ) !== undefined
    );
  }

  // Fenced on turn ownership, not on the turn being open: a turn this owner
  // already closed still saves its settled entries; a stale owner throws and
  // the whole batch rolls back.
  private applyConversationCheckpoint(checkpoint: RuntimeConversationCheckpoint): void {
    if (!this.isRuntimeTurnOwnedBy(checkpoint)) {
      throw new RuntimeTurnOwnershipLostError(checkpoint.turnId);
    }
    for (const entry of checkpoint.entries) {
      this.insertConversationEntryStmt.run(
        checkpoint.workspaceId,
        checkpoint.sessionId,
        entry.entryId,
        entry.json,
        checkpoint.turnId,
        checkpoint.piVersion,
        checkpoint.now,
        checkpoint.workspaceId,
        checkpoint.sessionId,
      );
    }
    for (const turnId of checkpoint.coveredTurnIds) {
      this.insertConversationTurnStmt.run(checkpoint.workspaceId, checkpoint.sessionId, turnId);
    }
  }

  loadConversation(workspaceId: WorkspaceId, sessionId: string): LoadedConversation {
    const entries = this.listConversationEntries(workspaceId, sessionId);
    const turns = (
      this.turnsForSessionStmt.all(workspaceId, sessionId) as Array<{
        turn_id: string;
        state: string;
        trigger_event_ids: string;
        close_reason: string | null;
      }>
    ).map((row) => ({
      turnId: row.turn_id,
      state: row.state,
      triggerEventIds: JSON.parse(row.trigger_event_ids) as string[],
      closeReason: row.close_reason,
    }));
    const userEvents = (
      this.userMessagesForSessionStmt.all(workspaceId, sessionId) as Array<{
        id: string;
        payload: string;
      }>
    ).map((row) => ({
      id: row.id,
      content: ((JSON.parse(row.payload) as { content?: ManagedAgentsContentBlock[] }).content ?? []),
    }));
    const coveredTurnIds = new Set(
      (this.conversationTurnsStmt.all(workspaceId, sessionId) as Array<{ turn_id: string }>).map(
        (row) => row.turn_id,
      ),
    );
    return {
      entries,
      unfinished: unfinishedUserMessages({ userEvents, turns, coveredTurnIds, stored: entries }),
    };
  }

  listConversationEntries(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): StoredConversationEntry[] {
    return (
      this.listConversationEntriesStmt.all(workspaceId, sessionId) as Array<{
        entry_id: string;
        entry_json: string;
        turn_id: string;
        pi_version: string;
      }>
    ).map((row) => ({
      entryId: row.entry_id,
      json: row.entry_json,
      turnId: row.turn_id,
      piVersion: row.pi_version,
    }));
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

const STATUS_BY_EVENT_TYPE: Record<string, ManagedAgentsSessionStatus> = {
  "session.status_running": "running",
  "session.status_idle": "idle",
  "session.status_rescheduled": "rescheduling",
  "session.status_terminated": "terminated",
};

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
