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
import { SqliteSessionStore } from "./sessions/store.ts";

export interface DeploymentStorageEnv {
  OMA_SQLITE_PATH?: string;
  OMA_FILE_STORAGE_ROOT?: string;
}

export interface DeploymentStores {
  agents: SqliteAgentStore;
  environments: SqliteEnvironmentStore;
  sessions: SqliteSessionStore;
  events: EventStore;
  files: FileStorage;
  mode: "memory" | "durable";
  sessionCoordinator: DeploymentSessionCoordinator;
  sessionOutputCoordinator: DeploymentSessionOutputCoordinator;
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
  if (sqlitePath === undefined || objectRoot === undefined) {
    return createInMemoryDeploymentStores();
  }
  if (sqlitePath === ":memory:") {
    throw new Error("OMA_SQLITE_PATH must be a file path, not :memory:");
  }
  return createDurableDeploymentStores(sqlitePath, objectRoot);
}

function createInMemoryDeploymentStores(): DeploymentStores {
  const agents = SqliteAgentStore.open(":memory:");
  const environments = SqliteEnvironmentStore.open(":memory:");
  const sessions = SqliteSessionStore.open(":memory:");
  const events = EventStore.open(":memory:");
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
  return {
    agents,
    environments,
    sessions,
    events,
    files,
    mode: "memory",
    sessionCoordinator,
    sessionOutputCoordinator,
    close: () => {
      agents.close();
      environments.close();
      sessions.close();
      events.close();
    },
  };
}

function createDurableDeploymentStores(
  sqlitePath: string,
  objectRoot: string,
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
    return {
      agents,
      environments,
      sessions,
      events,
      files,
      mode: "durable",
      sessionCoordinator,
      sessionOutputCoordinator,
      sqlitePragmas: () => readSqlitePragmas(db),
      close: () => {
        try {
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
