import type { DatabaseSync } from "node:sqlite";
import { withSqliteTransaction } from "../sqlite-transaction.ts";

// The events database schema and its in-place migrations, run on every open.
// Each migration is idempotent.
export function migrateEventStore(db: DatabaseSync): void {
  db.exec(SCHEMA);
  ensureWorkspaceIdColumn(db);
  ensureOpenModelRequestStartIdsColumn(db);
  ensureRuntimeTurnCloseReasonColumn(db);
  ensureConversationTurnsTable(db);
  ensureIdempotencyResourceColumns(db);
  db.exec(INDEXES);
}

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
  close_reason TEXT,
  PRIMARY KEY (workspace_id, session_id, turn_id)
);
-- Closed turns are retained as history (UPDATE, not DELETE), so live-turn
-- counts need a partial index or every /metrics scrape and /health check
-- scans all history (0121 C2 review, Codex-adv HIGH). Serves both the
-- workspace-scoped and unscoped counts.
CREATE INDEX IF NOT EXISTS idx_runtime_turns_live
ON pending_runtime_turns (workspace_id)
WHERE state NOT IN ('completed', 'terminalized');
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
CREATE TABLE IF NOT EXISTS idempotency_keys (
  workspace_id TEXT NOT NULL,
  method TEXT NOT NULL,
  concrete_path TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  route_label TEXT NOT NULL,
  fingerprint_sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  resource_type TEXT,
  resource_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, method, concrete_path, idempotency_key)
);
-- A session's Pi conversation, saved once per settled turn (plan 0147), so it
-- can be rebuilt after idle eviction or a restart. Deleted with the events.
CREATE TABLE IF NOT EXISTS session_conversation_entries (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  entry_id TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  pi_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, session_id, seq),
  UNIQUE (workspace_id, session_id, entry_id)
);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS events_by_workspace_session ON events (workspace_id, session_id, id);
CREATE INDEX IF NOT EXISTS events_by_workspace_session_type ON events (workspace_id, session_id, type, id);
CREATE INDEX IF NOT EXISTS pending_runtime_actions_by_turn
  ON pending_runtime_actions (workspace_id, session_id, turn_id);
CREATE INDEX IF NOT EXISTS idempotency_keys_by_status_expiry
  ON idempotency_keys (status, expires_at);
CREATE INDEX IF NOT EXISTS idempotency_keys_by_resource
  ON idempotency_keys (workspace_id, resource_type, resource_id);
`;

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

// Which runtime turns' user messages a saved checkpoint includes (plan 0147):
// the settled turn and any steered into it. A closed turn missing here never
// reached the saved conversation. When the table is first created, every turn
// already closed is marked covered: those predate this tracking (0.2.0 and
// earlier saved no conversation at all), so there is nothing honest to report
// about them, and reporting them would tell the model its whole history was
// cut off.
// One transaction: a crash mid-backfill must not leave an existing but
// incomplete table that later startups would treat as migrated.
function ensureConversationTurnsTable(db: DatabaseSync): void {
  withSqliteTransaction(db, () => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_conversation_turns'")
      .get();
    if (exists !== undefined) return;
    db.exec(`
      CREATE TABLE session_conversation_turns (
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        PRIMARY KEY (workspace_id, session_id, turn_id)
      );
      INSERT OR IGNORE INTO session_conversation_turns (workspace_id, session_id, turn_id)
        SELECT workspace_id, session_id, turn_id FROM pending_runtime_turns
        WHERE state IN ('completed', 'terminalized');
      INSERT OR IGNORE INTO session_conversation_turns (workspace_id, session_id, turn_id)
        SELECT DISTINCT workspace_id, session_id, turn_id FROM session_conversation_entries;
    `);
  });
}

// Why a turn closed (plan 0147): a deliberately interrupted turn is not
// reported to the model as cut off. Older rows have NULL.
function ensureRuntimeTurnCloseReasonColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(pending_runtime_turns)").all() as Array<{
    name: string;
  }>;
  if (columns.some((column) => column.name === "close_reason")) return;
  db.exec("ALTER TABLE pending_runtime_turns ADD COLUMN close_reason TEXT");
}

function ensureIdempotencyResourceColumns(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(idempotency_keys)").all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "resource_type")) {
    db.exec("ALTER TABLE idempotency_keys ADD COLUMN resource_type TEXT");
  }
  if (!columns.some((column) => column.name === "resource_id")) {
    db.exec("ALTER TABLE idempotency_keys ADD COLUMN resource_id TEXT");
  }
}

function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}
