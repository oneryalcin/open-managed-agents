import type { DatabaseSync } from "node:sqlite";
import { withSqliteTransaction } from "../sqlite-transaction.ts";
import { activeTimeState } from "./session-usage.ts";

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
  ensureSessionUsageTotals(db);
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

-- Plan 0148: what a span end's public model_usage lacks (Pi's cost and the
-- 1h share of cache writes), one row per real span end. Tokens are summed
-- from the span events themselves.
CREATE TABLE IF NOT EXISTS session_model_request_costs (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  span_event_id TEXT NOT NULL,
  cost_micros INTEGER,
  cache_write_1h_tokens INTEGER NOT NULL,
  provider TEXT,
  model_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, span_event_id)
);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS session_model_request_costs_by_session
  ON session_model_request_costs (workspace_id, session_id);
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

// Plan 0148: per-session usage totals, kept by triggers so a session list
// reads one row per session instead of summing its whole history (about
// 150 ms for 20 sessions of 2000 turns each). Triggers live in the database,
// so events written by an older OMA (after a rollback) still count.
//
// list_cost is unknown while spans_with_tokens > priced_spans_with_tokens:
// a cost row only counts as priced when its span used tokens, so a zero-token
// span's $0 row cannot stand in for a missing cost elsewhere.
// Active time follows activeTimeState: running opens an interval if none is
// open; idle, rescheduled and terminated close it.
const SESSION_USAGE_TRIGGERS = `
DROP TRIGGER IF EXISTS session_usage_span_end;
CREATE TRIGGER session_usage_span_end
AFTER INSERT ON events WHEN NEW.type = 'span.model_request_end'
BEGIN
  INSERT INTO session_usage_totals (
    workspace_id, session_id, span_count, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, spans_with_tokens)
  VALUES (
    NEW.workspace_id, NEW.session_id, 1,
    COALESCE(json_extract(NEW.payload, '$.model_usage.input_tokens'), 0),
    COALESCE(json_extract(NEW.payload, '$.model_usage.output_tokens'), 0),
    COALESCE(json_extract(NEW.payload, '$.model_usage.cache_read_input_tokens'), 0),
    COALESCE(json_extract(NEW.payload, '$.model_usage.cache_creation_input_tokens'), 0),
    ${spanHasTokens("NEW.payload")})
  ON CONFLICT (workspace_id, session_id) DO UPDATE SET
    span_count = span_count + 1,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
    spans_with_tokens = spans_with_tokens + excluded.spans_with_tokens;
END;

DROP TRIGGER IF EXISTS session_usage_running;
CREATE TRIGGER session_usage_running
AFTER INSERT ON events WHEN NEW.type = 'session.status_running'
BEGIN
  INSERT INTO session_usage_totals (workspace_id, session_id, running_since)
  VALUES (NEW.workspace_id, NEW.session_id, NEW.created_at)
  ON CONFLICT (workspace_id, session_id) DO UPDATE SET
    running_since = COALESCE(running_since, excluded.running_since);
END;

DROP TRIGGER IF EXISTS session_usage_stopped;
CREATE TRIGGER session_usage_stopped
AFTER INSERT ON events WHEN NEW.type IN (
  'session.status_idle', 'session.status_rescheduled', 'session.status_terminated')
BEGIN
  UPDATE session_usage_totals SET
    active_ms = active_ms + COALESCE(MAX(0, CAST(ROUND(
      (julianday(NEW.created_at) - julianday(running_since)) * 86400000) AS INTEGER)), 0),
    running_since = NULL
  WHERE workspace_id = NEW.workspace_id AND session_id = NEW.session_id
    AND running_since IS NOT NULL;
END;

DROP TRIGGER IF EXISTS session_usage_cost;
CREATE TRIGGER session_usage_cost
AFTER INSERT ON session_model_request_costs
BEGIN
  UPDATE session_usage_totals SET
    cost_micros = cost_micros + COALESCE(NEW.cost_micros, 0),
    cache_write_1h_tokens = cache_write_1h_tokens + NEW.cache_write_1h_tokens,
    priced_spans_with_tokens = priced_spans_with_tokens + (
      NEW.cost_micros IS NOT NULL AND EXISTS (
        SELECT 1 FROM events e
        WHERE e.workspace_id = NEW.workspace_id AND e.id = NEW.span_event_id
          AND ${spanHasTokens("e.payload")}))
  WHERE workspace_id = NEW.workspace_id AND session_id = NEW.session_id;
END;
`;

// Deleting events forgets their cost rows, and a session's totals once its
// last event is gone. In the database, so an older OMA's deletes clean up too.
const SESSION_USAGE_DELETE_TRIGGER = `
DROP TRIGGER IF EXISTS session_usage_event_deleted;
CREATE TRIGGER session_usage_event_deleted
AFTER DELETE ON events
BEGIN
  DELETE FROM session_model_request_costs
  WHERE workspace_id = OLD.workspace_id AND span_event_id = OLD.id;
  DELETE FROM session_usage_totals
  WHERE workspace_id = OLD.workspace_id AND session_id = OLD.session_id
    AND NOT EXISTS (
      SELECT 1 FROM events
      WHERE workspace_id = OLD.workspace_id AND session_id = OLD.session_id);
END;
`;

function spanHasTokens(payload: string): string {
  return `(COALESCE(json_extract(${payload}, '$.model_usage.input_tokens'), 0) +
    COALESCE(json_extract(${payload}, '$.model_usage.output_tokens'), 0) +
    COALESCE(json_extract(${payload}, '$.model_usage.cache_read_input_tokens'), 0) +
    COALESCE(json_extract(${payload}, '$.model_usage.cache_creation_input_tokens'), 0) > 0)`;
}

// The triggers are dropped and recreated on every open, so a change to their
// SQL reaches existing databases.
// Created once, then backfilled from the existing history in the same
// transaction (a crash cannot leave a half-filled table that later opens
// would trust); triggers are created after the backfill so it counts nothing
// twice.
function ensureSessionUsageTotals(db: DatabaseSync): void {
  withSqliteTransaction(db, () => {
    if (!hasTable(db, "session_usage_totals")) {
      db.exec(`
        CREATE TABLE session_usage_totals (
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          span_count INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
          cost_micros INTEGER NOT NULL DEFAULT 0,
          spans_with_tokens INTEGER NOT NULL DEFAULT 0,
          priced_spans_with_tokens INTEGER NOT NULL DEFAULT 0,
          active_ms INTEGER NOT NULL DEFAULT 0,
          running_since TEXT,
          PRIMARY KEY (workspace_id, session_id)
        );
        INSERT INTO session_usage_totals (
          workspace_id, session_id, span_count, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, cost_micros,
          spans_with_tokens, priced_spans_with_tokens)
        SELECT e.workspace_id, e.session_id, COUNT(*),
          SUM(COALESCE(json_extract(e.payload, '$.model_usage.input_tokens'), 0)),
          SUM(COALESCE(json_extract(e.payload, '$.model_usage.output_tokens'), 0)),
          SUM(COALESCE(json_extract(e.payload, '$.model_usage.cache_read_input_tokens'), 0)),
          SUM(COALESCE(json_extract(e.payload, '$.model_usage.cache_creation_input_tokens'), 0)),
          SUM(COALESCE(c.cache_write_1h_tokens, 0)),
          SUM(COALESCE(c.cost_micros, 0)),
          SUM(${spanHasTokens("e.payload")}),
          SUM(${spanHasTokens("e.payload")} AND c.cost_micros IS NOT NULL)
        FROM events e
        LEFT JOIN session_model_request_costs c
          ON c.workspace_id = e.workspace_id AND c.span_event_id = e.id
        WHERE e.type = 'span.model_request_end'
        GROUP BY e.workspace_id, e.session_id;
      `);
      backfillActiveTime(db);
    }
    db.exec(SESSION_USAGE_TRIGGERS);
    db.exec(SESSION_USAGE_DELETE_TRIGGER);
  });
}

function backfillActiveTime(db: DatabaseSync): void {
  const rows = db.prepare(
    `SELECT workspace_id, session_id, type, created_at FROM events
     WHERE type IN ('session.status_running', 'session.status_idle',
                    'session.status_rescheduled', 'session.status_terminated')
     ORDER BY workspace_id, session_id, rowid`,
  ).iterate() as Iterable<{ workspace_id: string; session_id: string; type: string; created_at: string }>;
  const upsert = db.prepare(
    `INSERT INTO session_usage_totals (workspace_id, session_id, active_ms, running_since)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (workspace_id, session_id) DO UPDATE SET
       active_ms = excluded.active_ms, running_since = excluded.running_since`,
  );
  let key: string | undefined;
  let current: { workspaceId: string; sessionId: string; events: Array<[boolean, string]> } | undefined;
  const flush = () => {
    if (current === undefined) return;
    const state = activeTimeState(current.events);
    upsert.run(current.workspaceId, current.sessionId, state.activeMs, state.runningSince);
  };
  for (const row of rows) {
    const rowKey = `${row.workspace_id}\u0000${row.session_id}`;
    if (rowKey !== key) {
      flush();
      key = rowKey;
      current = { workspaceId: row.workspace_id, sessionId: row.session_id, events: [] };
    }
    current!.events.push([row.type === "session.status_running", row.created_at]);
  }
  flush();
}
