import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteAgentStore } from "./agents/store.ts";
import {
  createBestEffortRuntimeEventCoordinator,
  createSingleDatabaseRuntimeEventCoordinator,
  type DeploymentRuntimeEventCoordinator,
} from "./deployment-runtime-event-coordinator.ts";
import {
  createInMemorySessionCoordinator,
  createSingleDatabaseSessionCoordinator,
  type DeploymentSessionCoordinator,
} from "./deployment-session-coordinator.ts";
import {
  createBestEffortSessionOutputCoordinator,
  createSingleDatabaseSessionOutputCoordinator,
  type DeploymentSessionOutputCoordinator,
} from "./deployment-session-output-coordinator.ts";
import { SqliteEnvironmentStore } from "./environments/store.ts";
import { EventStore } from "./events/store.ts";
import { InMemoryFileStorage, LocalObjectFileStorage } from "./files/store.ts";
import type { FileStorage } from "./files/types.ts";
import {
  loadMasterKey,
  MASTER_KEY_ENV,
  MASTER_KEY_FILE_ENV,
} from "./secrets/master-key.ts";
import { SqliteSecretsStore } from "./secrets/store.ts";
import { SqliteSessionStore } from "./sessions/store.ts";
import { SqliteVaultStore } from "./vaults/store.ts";
import { SqliteWorkspaceStore } from "./workspaces/store.ts";

export interface DeploymentStorageEnv {
  OMA_SQLITE_PATH?: string;
  OMA_FILE_STORAGE_ROOT?: string;
  OMA_MASTER_KEY?: string;
  OMA_MASTER_KEY_FILE?: string;
}

// Load the secrets master key only when the operator configured one. Returns
// undefined when NEITHER env var is set (no-secrets deployment — the store
// stays absent and the secrets API 4xxs). A malformed/ambiguous key still
// THROWS (fail-fast): a bad key must fail startup, not silently disable
// secrets. `loadMasterKey` throws its own "neither set" error, so we guard
// that one case before delegating.
function tryLoadMasterKey(env: DeploymentStorageEnv): Buffer | undefined {
  if (env[MASTER_KEY_ENV] === undefined && env[MASTER_KEY_FILE_ENV] === undefined) {
    return undefined;
  }
  return loadMasterKey({
    [MASTER_KEY_ENV]: env[MASTER_KEY_ENV],
    [MASTER_KEY_FILE_ENV]: env[MASTER_KEY_FILE_ENV],
  });
}

export interface DeploymentStores {
  agents: SqliteAgentStore;
  workspaces: SqliteWorkspaceStore;
  environments: SqliteEnvironmentStore;
  sessions: SqliteSessionStore;
  events: EventStore;
  files: FileStorage;
  // Present only when a master key is configured (OMA_MASTER_KEY[_FILE]);
  // undefined otherwise. The secrets HTTP API 4xxs when this is absent.
  secrets?: SqliteSecretsStore;
  vaults: SqliteVaultStore;
  mode: "memory" | "durable";
  sessionCoordinator: DeploymentSessionCoordinator;
  sessionOutputCoordinator: DeploymentSessionOutputCoordinator;
  runtimeEventCoordinator: DeploymentRuntimeEventCoordinator;
  sqlitePragmas?(): SqlitePragmaSnapshot;
  close(): void;
}

export interface SqlitePragmaSnapshot {
  journalMode: string;
  busyTimeout: number;
  foreignKeys: number;
  synchronous: number;
}

export function createDeploymentStoresFromEnv(
  env: DeploymentStorageEnv,
): DeploymentStores {
  const sqlitePath = normalizeEnvPath(env.OMA_SQLITE_PATH);
  const objectRoot = normalizeEnvPath(env.OMA_FILE_STORAGE_ROOT);
  if ((sqlitePath === undefined) !== (objectRoot === undefined)) {
    throw new Error(
      "OMA_SQLITE_PATH and OMA_FILE_STORAGE_ROOT must be set together for durable deployment storage",
    );
  }
  // Fail-fast on a malformed key regardless of storage mode, before opening
  // any database.
  const masterKey = tryLoadMasterKey(env);
  if (sqlitePath === undefined || objectRoot === undefined) {
    return createInMemoryDeploymentStores(masterKey);
  }
  if (sqlitePath === ":memory:") {
    throw new Error("OMA_SQLITE_PATH must be a file path, not :memory:");
  }
  return createDurableDeploymentStores(sqlitePath, objectRoot, masterKey);
}

function createInMemoryDeploymentStores(
  masterKey: Buffer | undefined,
): DeploymentStores {
  const agents = SqliteAgentStore.open(":memory:");
  const environments = SqliteEnvironmentStore.open(":memory:");
  const sessions = SqliteSessionStore.open(":memory:");
  const events = EventStore.open(":memory:");
  const workspaces = SqliteWorkspaceStore.open(":memory:");
  // Honor the key even in memory so tests can exercise the secrets path. When
  // secrets exist, vault metadata and secrets intentionally share one handle:
  // M2 credential writes rely on one outer transaction spanning both tables.
  const vaultDb = new DatabaseSync(":memory:");
  const secrets =
    masterKey === undefined ? undefined : new SqliteSecretsStore(vaultDb, masterKey);
  const vaults = new SqliteVaultStore(vaultDb, secrets);
  const files = new InMemoryFileStorage();
  const sessionCoordinator = createInMemorySessionCoordinator({
    sessions,
    events,
  });
  const sessionOutputCoordinator = createBestEffortSessionOutputCoordinator({
    sessions,
    events,
    files,
  });
  const runtimeEventCoordinator = createBestEffortRuntimeEventCoordinator({
    sessions,
    events,
  });
  return {
    agents,
    workspaces,
    environments,
    sessions,
    events,
    files,
    secrets,
    vaults,
    mode: "memory",
    sessionCoordinator,
    sessionOutputCoordinator,
    runtimeEventCoordinator,
    close: () => {
      agents.close();
      environments.close();
      sessions.close();
      events.close();
      workspaces.close();
      secrets?.scrubMasterKey();
      vaults.close();
    },
  };
}

function createDurableDeploymentStores(
  sqlitePath: string,
  objectRoot: string,
  masterKey: Buffer | undefined,
): DeploymentStores {
  const resolvedSqlitePath = resolve(sqlitePath);
  const requestedObjectRoot = resolve(objectRoot);
  mkdirSync(dirname(resolvedSqlitePath), { recursive: true, mode: 0o700 });
  mkdirSync(requestedObjectRoot, { recursive: true, mode: 0o700 });
  const resolvedObjectRoot = realpathSync(requestedObjectRoot);
  chmodSync(resolvedObjectRoot, 0o700);
  const releaseLock = acquireStorageLock(resolvedSqlitePath, resolvedObjectRoot);
  try {
    const db = new DatabaseSync(resolvedSqlitePath);
    chmodSync(resolvedSqlitePath, 0o600);
    applyDurablePragmas(db);
    ensureStorageBinding(db, resolvedObjectRoot);
    const agents = new SqliteAgentStore(db);
    const environments = new SqliteEnvironmentStore(db);
    const sessions = new SqliteSessionStore(db);
    const events = new EventStore(db);
    const workspaces = new SqliteWorkspaceStore(db);
    // Shares the single durable connection with every other store; its own
    // close() is intentionally NOT wired into close() below, which closes the
    // shared db exactly once.
    const secrets =
      masterKey === undefined ? undefined : new SqliteSecretsStore(db, masterKey);
    const vaults = new SqliteVaultStore(db, secrets);
    const files = new LocalObjectFileStorage(db, resolvedObjectRoot);
    const sessionCoordinator = createSingleDatabaseSessionCoordinator({
      sessions,
      events,
      files,
    });
    const sessionOutputCoordinator = createSingleDatabaseSessionOutputCoordinator({
      sessions,
      events,
      files,
    });
    const runtimeEventCoordinator = createSingleDatabaseRuntimeEventCoordinator({
      sessions,
      events,
    });
    return {
      agents,
      workspaces,
      environments,
      sessions,
      events,
      files,
      secrets,
      vaults,
      mode: "durable",
      sessionCoordinator,
      sessionOutputCoordinator,
      runtimeEventCoordinator,
      sqlitePragmas: () => readSqlitePragmas(db),
      close: () => {
        try {
          secrets?.scrubMasterKey(); // shares db (closed below); scrub the key
          db.close();
        } finally {
          releaseLock();
        }
      },
    };
  } catch (error) {
    releaseLock();
    throw error;
  }
}

// 0113 D8: the provisioning entry point for a live server's database. Opens a
// second connection with the same durability pragmas — busy_timeout is
// per-connection, so without it a concurrent server write makes key
// mint/revoke fail instantly with SQLITE_BUSY. Deliberately does NOT take the
// .oma.lock: that lock guards single-server ownership (runtime recovery, turn
// coordination), not table writes; WAL is built for this short-lived writer.
export function openWorkspaceStoreForProvisioning(
  sqlitePath: string,
): SqliteWorkspaceStore {
  const resolvedSqlitePath = resolve(sqlitePath);
  if (!existsSync(resolvedSqlitePath)) {
    throw new Error(
      `Provisioning requires an existing OMA database, none found at ${resolvedSqlitePath}. ` +
        "Start the server with OMA_SQLITE_PATH once (or check the path) before provisioning keys.",
    );
  }
  const db = new DatabaseSync(resolvedSqlitePath);
  try {
    // busy_timeout is connection-local and touches nothing on disk; set it
    // before the identity check so the check itself survives contention.
    db.exec("PRAGMA busy_timeout = 5000");
    // Refuse to touch a file the durable server never initialized: a typo'd
    // path to some other SQLite database would otherwise gain OMA auth
    // tables (and even a persistent WAL header flip from the pragmas below),
    // and the minted key would never reach the real server.
    const marker = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'deployment_storage_config'`,
      )
      .get();
    if (marker === undefined) {
      throw new Error(
        `${resolvedSqlitePath} is not an initialized OMA durable database ` +
          "(missing deployment_storage_config). Start the server once with " +
          "OMA_SQLITE_PATH and OMA_FILE_STORAGE_ROOT before provisioning keys.",
      );
    }
    applyDurablePragmas(db);
    return new SqliteWorkspaceStore(db);
  } catch (error) {
    db.close();
    throw error;
  }
}

export function applyDurablePragmas(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;
  `);
}

function readSqlitePragmas(db: DatabaseSync): SqlitePragmaSnapshot {
  return {
    journalMode: (db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    }).journal_mode,
    busyTimeout: (db.prepare("PRAGMA busy_timeout").get() as {
      timeout: number;
    }).timeout,
    foreignKeys: (db.prepare("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    }).foreign_keys,
    synchronous: (db.prepare("PRAGMA synchronous").get() as {
      synchronous: number;
    }).synchronous,
  };
}

function ensureStorageBinding(db: DatabaseSync, objectRoot: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployment_storage_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  db.prepare(
    `INSERT OR IGNORE INTO deployment_storage_config (key, value)
     VALUES ('object_root', ?)`,
  ).run(objectRoot);
  const row = db.prepare(
    `SELECT value FROM deployment_storage_config WHERE key = 'object_root'`,
  ).get() as { value: string } | undefined;
  if (row?.value !== objectRoot) {
    throw new Error(
      `OMA_SQLITE_PATH is already bound to object storage root ${row?.value ?? "<missing>"}. ` +
        `Refusing to open it with ${objectRoot}.`,
    );
  }
}

function normalizeEnvPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Durable storage env vars must not be empty");
  }
  return trimmed;
}

function acquireStorageLock(sqlitePath: string, objectRoot: string): () => void {
  const lockPath = `${sqlitePath}.oma.lock`;
  let fd = openLockFile(lockPath, objectRoot);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(fd);
    unlinkIfExistsSync(lockPath);
  };
}

function openLockFile(lockPath: string, objectRoot: string): number {
  try {
    return createLockFile(lockPath, objectRoot);
  } catch (error) {
    if ((error as { code?: unknown }).code === "EEXIST") {
      if (removeStaleLock(lockPath)) {
        return createLockFile(lockPath, objectRoot);
      }
      throw lockedStorageError(lockPath);
    }
    throw error;
  }
}

function createLockFile(lockPath: string, objectRoot: string): number {
  const fd = openSync(lockPath, "wx", 0o600);
  try {
    writeFileSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        objectRoot,
        createdAt: new Date().toISOString(),
      }),
    );
    return fd;
  } catch (error) {
    closeSync(fd);
    unlinkIfExistsSync(lockPath);
    throw error;
  }
}

function removeStaleLock(lockPath: string): boolean {
  const pid = readLockPid(lockPath);
  if (pid === undefined || isProcessRunning(pid)) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return true;
    throw error;
  }
}

function readLockPid(lockPath: string): number | undefined {
  if (!existsSync(lockPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as {
      pid?: unknown;
    };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid)
      ? parsed.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

function lockedStorageError(lockPath: string): Error {
  return new Error(
    `Durable storage database is already locked: ${lockPath}. ` +
      "OMA durable mode requires exclusive process access; stop the other process before reusing this SQLite path.",
  );
}

function unlinkIfExistsSync(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
  }
}
