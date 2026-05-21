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
import type { PersistedSessionEvent } from "./types.ts";

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
  /** Cursor — return events with `id > afterId`. Omit to start from the beginning. */
  afterId?: string;
  /** Page size cap. Default 1000. */
  limit?: number;
}

export class EventStore {
  private readonly db: DatabaseSync;
  private readonly appendStmt: StatementSync;
  private readonly listAllStmt: StatementSync;
  private readonly listSinceStmt: StatementSync;
  private readonly retrieveStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
    this.appendStmt = this.db.prepare(
      `INSERT INTO events (id, session_id, type, processed_at, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.listAllStmt = this.db.prepare(
      `SELECT id, session_id, type, processed_at, payload, created_at
       FROM events
       WHERE session_id = ?
       ORDER BY id ASC
       LIMIT ?`,
    );
    this.listSinceStmt = this.db.prepare(
      `SELECT id, session_id, type, processed_at, payload, created_at
       FROM events
       WHERE session_id = ? AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
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

  list(sessionId: string, opts: ListOptions = {}): PersistedSessionEvent[] {
    const limit = opts.limit ?? 1000;
    const rows = (
      opts.afterId !== undefined
        ? this.listSinceStmt.all(sessionId, opts.afterId, limit)
        : this.listAllStmt.all(sessionId, limit)
    ) as unknown as EventRow[];
    return rows.map(deserialize);
  }

  retrieve(id: string): PersistedSessionEvent | undefined {
    const row = this.retrieveStmt.get(id) as unknown as EventRow | undefined;
    return row ? deserialize(row) : undefined;
  }

  close(): void {
    this.db.close();
  }
}

function deserialize(row: EventRow): PersistedSessionEvent {
  return {
    id: row.id,
    session_id: row.session_id,
    type: row.type as EventType,
    processed_at: row.processed_at,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    created_at: row.created_at,
  };
}
