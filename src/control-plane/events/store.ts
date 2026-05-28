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
import type {
  ListSessionEventRecordsOptions,
  PersistedSessionEvent,
  SessionEventRecordPage,
  SessionEventStore,
} from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  type         TEXT NOT NULL,
  processed_at TEXT,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_session ON events (session_id, id);
CREATE INDEX IF NOT EXISTS events_by_session_type ON events (session_id, type, id);
`;

interface EventRow {
  id: string;
  session_id: string;
  type: string;
  processed_at: string | null;
  payload: string;
  created_at: string;
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
  private readonly retrieveStmt: StatementSync;
  private readonly listStmts = new Map<string, StatementSync>();

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
    this.appendStmt = this.db.prepare(
      `INSERT INTO events (id, session_id, type, processed_at, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.deleteForSessionStmt = this.db.prepare(
      `DELETE FROM events WHERE session_id = ?`,
    );
    this.retrieveStmt = this.db.prepare(
      `SELECT id, session_id, type, processed_at, payload, created_at
       FROM events WHERE id = ?`,
    );
  }

  /** Open a store backed by a SQLite file. Pass `:memory:` for in-memory. */
  static open(path = ":memory:"): EventStore {
    return new EventStore(new DatabaseSync(path));
  }

  append(event: PersistedSessionEvent): void {
    this.appendStmt.run(
      event.id,
      event.session_id,
      event.type,
      event.processed_at,
      JSON.stringify(event.payload),
      event.created_at,
    );
  }

  appendBatch(events: readonly PersistedSessionEvent[]): void {
    this.db.exec("BEGIN");
    try {
      for (const event of events) {
        this.appendStmt.run(
          event.id,
          event.session_id,
          event.type,
          event.processed_at,
          JSON.stringify(event.payload),
          event.created_at,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteForSession(sessionId: string): void {
    this.deleteForSessionStmt.run(sessionId);
  }

  list(sessionId: string, opts: ListOptions = {}): PersistedSessionEvent[] {
    return this.listPage(sessionId, {
      ...opts,
      limit: opts.limit ?? 1000,
    }).data;
  }

  listPage(
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
    const rows = stmt.all(...selectListArgs(sessionId, cursor, limit + 1, opts.types)) as unknown as EventRow[];
    const data = rows.slice(0, limit).map(deserialize);
    return {
      data,
      next_page: rows.length > limit ? data[data.length - 1]?.id ?? null : null,
    };
  }

  retrieve(id: string): PersistedSessionEvent | undefined {
    const row = this.retrieveStmt.get(id) as unknown as EventRow | undefined;
    return row ? deserialize(row) : undefined;
  }

  close(): void {
    this.db.close();
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

    const predicates = ["session_id = ?"];
    if (opts.types.length > 0) {
      predicates.push(`type IN (${opts.types.map(() => "?").join(", ")})`);
    }
    if (opts.hasCursor) {
      predicates.push(opts.order === "asc" ? "id > ?" : "id < ?");
    }
    const stmt = this.db.prepare(
      `SELECT id, session_id, type, processed_at, payload, created_at
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
  sessionId: string,
  cursor: string | undefined,
  limit: number,
  types: readonly string[] | undefined,
): [string, number] | [string, ...string[], number] | [string, string, number] | [string, ...string[], string, number] {
  const t = types ?? [];
  if (cursor === undefined) {
    return t.length === 0 ? [sessionId, limit] : [sessionId, ...t, limit];
  }
  return t.length === 0
    ? [sessionId, cursor, limit]
    : [sessionId, ...t, cursor, limit];
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
    session_id: row.session_id,
    type: row.type as EventType,
    processed_at: row.processed_at,
    payload: JSON.parse(row.payload) as JsonObject,
    created_at: row.created_at,
  };
}
