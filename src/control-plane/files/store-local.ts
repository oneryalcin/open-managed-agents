import { randomUUID } from "node:crypto";
import {
  createReadStream,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { invalidRequest } from "../errors.ts";
import { newFileId } from "../ids.ts";
import { withSqliteTransaction } from "../sqlite-transaction.ts";
import type {
  FileListOptions,
  FileStorage,
  FileStoragePage,
  FileStorageRecord,
  InternalFileSnapshotInput,
  SessionOutputFileInput,
  StoredFile,
  UploadedFileInput,
  WorkspaceId,
} from "./types.ts";
import {
  MAX_SESSION_OUTPUT_BYTES,
  MAX_SESSION_OUTPUT_FILENAME_BYTES,
  MAX_SESSION_OUTPUT_FILE_BYTES,
  MAX_SESSION_OUTPUT_FILES,
  MAX_UPLOADED_FILE_BYTES,
  MAX_WORKSPACE_FILE_BYTES,
} from "./types.ts";
import {
  compareRecords,
  consumeUploadBody,
  limitLabel,
  normalizeLimit,
  reusableOutput,
  toRecord,
  validateOutputFilename,
} from "./store-common.ts";

const FILE_STORAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  visibility    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  scope_id      TEXT,
  relative_path TEXT,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  downloadable  INTEGER NOT NULL,
  scope         TEXT NOT NULL,
  storage_key   TEXT NOT NULL UNIQUE,
  sha256        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_by_workspace_public
  ON files (workspace_id, visibility, scope_id, id);
CREATE INDEX IF NOT EXISTS files_session_outputs
  ON files (workspace_id, kind, scope_id, id);
`;

interface FileDbRow {
  id: string;
  workspace_id: WorkspaceId;
  visibility: StoredFile["visibility"];
  kind: StoredFile["kind"];
  scope_id: string | null;
  relative_path: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  downloadable: 0 | 1;
  scope: string;
  storage_key: string;
  sha256: string;
}

export class LocalObjectFileStorage implements FileStorage {
  private readonly objectRoot: string;
  private readonly objectsDir: string;
  private readonly tmpDir: string;
  private readonly insertStmt: StatementSync;
  private readonly retrievePublicStmt: StatementSync;
  private readonly retrieveInternalStmt: StatementSync;
  private readonly retrieveStoredStmt: StatementSync;
  private readonly deletePublicStmt: StatementSync;
  private readonly deleteInternalStmt: StatementSync;
  private readonly deleteSessionOutputsStmt: StatementSync;
  private readonly listPublicStmt: StatementSync;
  private readonly listPublicAfterStmt: StatementSync;
  private readonly listPublicBeforeStmt: StatementSync;
  private readonly listSessionOutputsStmt: StatementSync;
  private readonly listSessionOutputsAfterStmt: StatementSync;
  private readonly listSessionOutputsBeforeStmt: StatementSync;
  private readonly sessionOutputsStmt: StatementSync;
  private readonly workspaceBytesStmt: StatementSync;
  private readonly maxUploadedFileBytes: number;
  private readonly maxWorkspaceFileBytes: number;
  private readonly maxSessionOutputFiles: number;
  private readonly maxSessionOutputFileBytes: number;
  private readonly maxSessionOutputBytes: number;
  private readonly maxSessionOutputFilenameBytes: number;

  constructor(
    private readonly db: DatabaseSync,
    objectRoot: string,
    opts: {
      maxUploadedFileBytes?: number;
      maxWorkspaceFileBytes?: number;
      maxSessionOutputFiles?: number;
      maxSessionOutputFileBytes?: number;
      maxSessionOutputBytes?: number;
      maxSessionOutputFilenameBytes?: number;
    } = {},
  ) {
    this.objectRoot = resolve(objectRoot);
    this.objectsDir = resolve(this.objectRoot, "objects");
    this.tmpDir = resolve(this.objectRoot, "tmp");
    mkdirSync(this.objectRoot, { recursive: true, mode: 0o700 });
    mkdirSync(this.objectsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
    chmodSync(this.objectRoot, 0o700);
    chmodSync(this.objectsDir, 0o700);
    chmodSync(this.tmpDir, 0o700);
    this.db.exec(FILE_STORAGE_SCHEMA);
    this.insertStmt = this.db.prepare(
      `INSERT INTO files (
        id, workspace_id, visibility, kind, scope_id, relative_path, filename,
        mime_type, size_bytes, created_at, downloadable, scope, storage_key,
        sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.retrievePublicStmt = this.db.prepare(
      `SELECT * FROM files
       WHERE workspace_id = ? AND id = ? AND visibility = 'public'`,
    );
    this.retrieveInternalStmt = this.db.prepare(
      `SELECT * FROM files
       WHERE workspace_id = ? AND id = ? AND visibility = 'internal'`,
    );
    this.retrieveStoredStmt = this.db.prepare(
      `SELECT * FROM files WHERE workspace_id = ? AND id = ?`,
    );
    this.deletePublicStmt = this.db.prepare(
      `DELETE FROM files
       WHERE workspace_id = ? AND id = ? AND visibility = 'public'`,
    );
    this.deleteInternalStmt = this.db.prepare(
      `DELETE FROM files
       WHERE workspace_id = ? AND id = ? AND visibility = 'internal'`,
    );
    this.deleteSessionOutputsStmt = this.db.prepare(
      `DELETE FROM files
       WHERE workspace_id = ? AND kind = 'session_output' AND scope_id = ?`,
    );
    this.listPublicStmt = this.db.prepare(publicListSql("", "ASC"));
    this.listPublicAfterStmt = this.db.prepare(publicListSql("AND id > ?", "ASC"));
    this.listPublicBeforeStmt = this.db.prepare(publicListSql("AND id < ?", "DESC"));
    this.listSessionOutputsStmt = this.db.prepare(sessionOutputListSql("", "ASC"));
    this.listSessionOutputsAfterStmt = this.db.prepare(
      sessionOutputListSql("AND id > ?", "ASC"),
    );
    this.listSessionOutputsBeforeStmt = this.db.prepare(
      sessionOutputListSql("AND id < ?", "DESC"),
    );
    this.sessionOutputsStmt = this.db.prepare(
      `SELECT * FROM files
       WHERE workspace_id = ? AND visibility = 'public'
         AND kind = 'session_output' AND scope_id = ?
       ORDER BY id ASC`,
    );
    this.workspaceBytesStmt = this.db.prepare(
      `SELECT COALESCE(SUM(size_bytes), 0) AS total
       FROM files WHERE workspace_id = ?`,
    );
    this.maxUploadedFileBytes =
      opts.maxUploadedFileBytes ?? MAX_UPLOADED_FILE_BYTES;
    this.maxWorkspaceFileBytes =
      opts.maxWorkspaceFileBytes ?? MAX_WORKSPACE_FILE_BYTES;
    this.maxSessionOutputFiles =
      opts.maxSessionOutputFiles ?? MAX_SESSION_OUTPUT_FILES;
    this.maxSessionOutputFileBytes =
      opts.maxSessionOutputFileBytes ?? MAX_SESSION_OUTPUT_FILE_BYTES;
    this.maxSessionOutputBytes =
      opts.maxSessionOutputBytes ?? MAX_SESSION_OUTPUT_BYTES;
    this.maxSessionOutputFilenameBytes =
      opts.maxSessionOutputFilenameBytes ?? MAX_SESSION_OUTPUT_FILENAME_BYTES;
    this.sweepTempAndOrphanedObjects();
  }

  async create(
    workspaceId: WorkspaceId,
    input: UploadedFileInput,
  ): Promise<FileStorageRecord> {
    return this.createStored(workspaceId, input, {
      visibility: "public",
      kind: "upload",
      scope: null,
      scopeId: null,
      fileId: undefined,
      downloadable: false,
      relativePath: undefined,
      maxBytes: this.maxUploadedFileBytes,
    });
  }

  async createInternalSnapshot(
    workspaceId: WorkspaceId,
    input: InternalFileSnapshotInput,
  ): Promise<FileStorageRecord> {
    return this.createStored(workspaceId, input, {
      visibility: "internal",
      kind: "internal_snapshot",
      scope: { type: "session", id: input.scopeId },
      scopeId: input.scopeId,
      fileId: input.fileId,
      downloadable: false,
      relativePath: undefined,
      maxBytes: this.maxUploadedFileBytes,
    });
  }

  private async createStored(
    workspaceId: WorkspaceId,
    input: UploadedFileInput,
    opts: {
      visibility: StoredFile["visibility"];
      kind: StoredFile["kind"];
      scope: StoredFile["metadata"]["scope"];
      scopeId: string | null;
      fileId: string | undefined;
      downloadable: boolean;
      relativePath: string | undefined;
      maxBytes: number;
    },
  ): Promise<FileStorageRecord> {
    const { bytes, sizeBytes, sha256 } = await consumeUploadBody(
      input.body,
      opts.maxBytes,
      opts.kind === "session_output" ? "Session output file" : "Uploaded file",
    );
    const id = opts.fileId ?? newFileId();
    const now = new Date().toISOString();
    let objectPath: string | undefined;
    try {
      return this.withTransaction(() => {
        if (
          this.workspaceBytes(workspaceId) + sizeBytes >
          this.maxWorkspaceFileBytes
        ) {
          throw invalidRequest(
            `Workspace file storage exceeds the ${limitLabel(this.maxWorkspaceFileBytes)} local-object limit`,
          );
        }
        if (this.retrieveStored(workspaceId, id)) {
          throw invalidRequest(`File ${id} already exists`);
        }
        const object = this.writeObjectSync(bytes);
        objectPath = object.path;
        const stored: StoredFile = {
          visibility: opts.visibility,
          kind: opts.kind,
          workspace_id: workspaceId,
          storage_key: object.storageKey,
          sha256,
          bytes,
          scope_id: opts.scopeId,
          relative_path: opts.relativePath,
          metadata: {
            id,
            type: "file",
            filename: input.filename,
            mime_type: input.mimeType,
            size_bytes: sizeBytes,
            created_at: now,
            downloadable: opts.downloadable,
            scope: opts.scope,
          },
        };
        this.insertStored(stored);
        return toRecord(stored);
      });
    } catch (error) {
      if (objectPath !== undefined) await unlinkIfExists(objectPath);
      throw error;
    }
  }

  async retrieveMetadata(
    workspaceId: WorkspaceId,
    fileId: string,
  ): Promise<FileStorageRecord | undefined> {
    const row = this.retrievePublicStmt.get(
      workspaceId,
      fileId,
    ) as unknown as FileDbRow | undefined;
    return row ? toRecord(rowToStored(row)) : undefined;
  }

  async openBytes(
    workspaceId: WorkspaceId,
    fileId: string,
  ): Promise<AsyncIterable<Uint8Array> | undefined> {
    const row = this.retrievePublicStmt.get(
      workspaceId,
      fileId,
    ) as unknown as FileDbRow | undefined;
    if (!row) return undefined;
    const path = this.objectPath(row.storage_key);
    if (!existsSync(path)) return undefined;
    return createReadStream(path) as AsyncIterable<Uint8Array>;
  }

  async openInternalSnapshotBytes(
    workspaceId: WorkspaceId,
    fileId: string,
  ): Promise<AsyncIterable<Uint8Array> | undefined> {
    const row = this.retrieveInternalStmt.get(
      workspaceId,
      fileId,
    ) as unknown as FileDbRow | undefined;
    if (!row) return undefined;
    const path = this.objectPath(row.storage_key);
    if (!existsSync(path)) return undefined;
    return createReadStream(path) as AsyncIterable<Uint8Array>;
  }

  async delete(workspaceId: WorkspaceId, fileId: string): Promise<boolean> {
    const deleted = this.deletePublicRow(workspaceId, fileId);
    if (!deleted) return false;
    await unlinkIfExists(this.objectPath(deleted.storage_key));
    return true;
  }

  async deleteInternalSnapshot(
    workspaceId: WorkspaceId,
    fileId: string,
  ): Promise<boolean> {
    const deleted = this.deleteInternalRow(workspaceId, fileId);
    if (!deleted) return false;
    await unlinkIfExists(this.objectPath(deleted.storage_key));
    return true;
  }

  async replaceSessionOutputs(
    workspaceId: WorkspaceId,
    sessionId: string,
    files: readonly SessionOutputFileInput[],
  ): Promise<readonly FileStorageRecord[]> {
    return this.replaceSessionOutputsIfLive(
      workspaceId,
      sessionId,
      files,
      () => true,
    );
  }

  async replaceSessionOutputsIfLive(
    workspaceId: WorkspaceId,
    sessionId: string,
    files: readonly SessionOutputFileInput[],
    canCommit: () => boolean,
  ): Promise<readonly FileStorageRecord[]> {
    if (files.length > this.maxSessionOutputFiles) {
      throw invalidRequest(
        `Session output collection exceeds the ${this.maxSessionOutputFiles} file limit`,
      );
    }
    const basenameOwners = new Map<string, string>();
    const preparedInputs: Array<{
      input: SessionOutputFileInput;
      bytes: Uint8Array;
      sizeBytes: number;
      sha256: string;
    }> = [];
    let prepared: StoredFile[] = [];
    let oldOutputs: StoredFile[] = [];
    const newObjectPaths: string[] = [];
    let committed = false;
    let totalOutputBytes = 0;
    try {
      for (const file of files) {
        validateOutputFilename(file.filename, this.maxSessionOutputFilenameBytes);
        const existingRelativePath = basenameOwners.get(file.filename);
        if (
          existingRelativePath !== undefined &&
          existingRelativePath !== file.relativePath
        ) {
          throw invalidRequest(
            `Session output filename collision for '${file.filename}' from '${existingRelativePath}' and '${file.relativePath}'`,
          );
        }
        basenameOwners.set(file.filename, file.relativePath);
        if (
          file.sizeBytes !== undefined &&
          file.sizeBytes > this.maxSessionOutputFileBytes
        ) {
          throw invalidRequest(
            `Session output file exceeds the ${limitLabel(this.maxSessionOutputFileBytes)} per-file limit`,
          );
        }
        if (
          file.sizeBytes !== undefined &&
          totalOutputBytes + file.sizeBytes > this.maxSessionOutputBytes
        ) {
          throw invalidRequest(
            `Session outputs exceed the ${limitLabel(this.maxSessionOutputBytes)} aggregate limit`,
          );
        }
        const { bytes, sizeBytes, sha256 } = await consumeUploadBody(
          file.body,
          this.maxSessionOutputFileBytes,
          "Session output file",
        );
        if (file.sizeBytes !== undefined && file.sizeBytes !== sizeBytes) {
          throw invalidRequest(
            `Session output '${file.relativePath}' size changed during collection`,
          );
        }
        if (file.sha256 !== undefined && file.sha256 !== sha256) {
          throw invalidRequest(
            `Session output '${file.relativePath}' checksum changed during collection`,
          );
        }
        totalOutputBytes += sizeBytes;
        if (totalOutputBytes > this.maxSessionOutputBytes) {
          throw invalidRequest(
            `Session outputs exceed the ${limitLabel(this.maxSessionOutputBytes)} aggregate limit`,
          );
        }
        preparedInputs.push({ input: file, bytes, sizeBytes, sha256 });
      }

      this.withTransaction(() => {
        if (!canCommit()) {
          throw invalidRequest(
            `Session outputs cannot be committed for inactive session ${sessionId}`,
          );
        }
        oldOutputs = this.sessionOutputFiles(workspaceId, sessionId);
        const reusableOutputByRelativePath = new Map(
          oldOutputs
            .filter((stored) => stored.relative_path !== undefined)
            .map((stored) => [stored.relative_path!, stored]),
        );
        prepared = preparedInputs.map(({ input, bytes, sizeBytes, sha256 }) => {
          const reusable = reusableOutput(
            reusableOutputByRelativePath.get(input.relativePath),
            input,
            sizeBytes,
            sha256,
          );
          const id = reusable?.metadata.id ?? newFileId();
          const createdAt =
            reusable?.metadata.created_at ?? new Date().toISOString();
          return {
            visibility: "public",
            kind: "session_output",
            workspace_id: workspaceId,
            storage_key: reusable?.storage_key ?? "",
            sha256,
            bytes,
            scope_id: sessionId,
            relative_path: input.relativePath,
            metadata: {
              id,
              type: "file",
              filename: input.filename,
              mime_type: input.mimeType,
              size_bytes: sizeBytes,
              created_at: createdAt,
              downloadable: true,
              scope: { type: "session", id: sessionId },
            },
          };
        });
        const oldBytes = oldOutputs.reduce(
          (sum, stored) => sum + stored.metadata.size_bytes,
          0,
        );
        if (
          this.workspaceBytes(workspaceId) - oldBytes + totalOutputBytes >
          this.maxWorkspaceFileBytes
        ) {
          throw invalidRequest(
            `Workspace file storage exceeds the ${limitLabel(this.maxWorkspaceFileBytes)} local-object limit`,
          );
        }
        for (const stored of prepared) {
          if (stored.storage_key !== "") continue;
          const object = this.writeObjectSync(stored.bytes);
          stored.storage_key = object.storageKey;
          newObjectPaths.push(object.path);
        }
        this.deleteSessionOutputsStmt.run(workspaceId, sessionId);
        for (const stored of prepared) {
          this.insertStored(stored);
        }
        committed = true;
      });

      const keptStorageKeys = new Set(prepared.map((stored) => stored.storage_key));
      await Promise.all(
        oldOutputs
          .filter((stored) => !keptStorageKeys.has(stored.storage_key))
          .map((stored) => unlinkIfExists(this.objectPath(stored.storage_key))),
      );
      return prepared.map(toRecord).sort(compareRecords);
    } catch (error) {
      if (!committed) {
        await Promise.all(newObjectPaths.map(unlinkIfExists));
      }
      throw error;
    }
  }

  deleteSessionOutputRows(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): readonly FileStorageRecord[] {
    return this.withTransaction(() => {
      const oldOutputs = this.sessionOutputFiles(workspaceId, sessionId);
      this.deleteSessionOutputsStmt.run(workspaceId, sessionId);
      return oldOutputs.map(toRecord).sort(compareRecords);
    });
  }

  async deleteObjectsForRecords(
    records: readonly FileStorageRecord[],
  ): Promise<void> {
    await Promise.all(
      records.map((record) => unlinkIfExists(this.objectPath(record.storage_key))),
    );
  }

  async deleteSessionOutputs(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<void> {
    const oldOutputs = this.deleteSessionOutputRows(workspaceId, sessionId);
    await this.deleteObjectsForRecords(oldOutputs);
  }

  async list(
    workspaceId: WorkspaceId,
    opts: FileListOptions = {},
  ): Promise<FileStoragePage> {
    const limit = normalizeLimit(opts.limit);
    const queryLimit = limit + 1;
    const rows = this.selectListRows(workspaceId, opts, queryLimit)
      .map(rowToStored)
      .map(toRecord);
    const pageRows = rows.slice(0, limit);
    const data =
      opts.beforeId === undefined
        ? pageRows
        : pageRows.sort(compareRecords);
    return {
      data,
      has_more: rows.length > limit,
      first_id: data[0]?.metadata.id ?? null,
      last_id: data[data.length - 1]?.metadata.id ?? null,
    };
  }

  private selectListRows(
    workspaceId: WorkspaceId,
    opts: FileListOptions,
    limit: number,
  ): FileDbRow[] {
    if (opts.scopeId === undefined) {
      if (opts.beforeId !== undefined) {
        return this.listPublicBeforeStmt.all(
          workspaceId,
          opts.beforeId,
          limit,
        ) as unknown as FileDbRow[];
      }
      if (opts.afterId !== undefined) {
        return this.listPublicAfterStmt.all(
          workspaceId,
          opts.afterId,
          limit,
        ) as unknown as FileDbRow[];
      }
      return this.listPublicStmt.all(workspaceId, limit) as unknown as FileDbRow[];
    }
    if (opts.beforeId !== undefined) {
      return this.listSessionOutputsBeforeStmt.all(
        workspaceId,
        opts.scopeId,
        opts.beforeId,
        limit,
      ) as unknown as FileDbRow[];
    }
    if (opts.afterId !== undefined) {
      return this.listSessionOutputsAfterStmt.all(
        workspaceId,
        opts.scopeId,
        opts.afterId,
        limit,
      ) as unknown as FileDbRow[];
    }
    return this.listSessionOutputsStmt.all(
      workspaceId,
      opts.scopeId,
      limit,
    ) as unknown as FileDbRow[];
  }

  private retrieveStored(
    workspaceId: WorkspaceId,
    fileId: string,
  ): StoredFile | undefined {
    const row = this.retrieveStoredStmt.get(
      workspaceId,
      fileId,
    ) as unknown as FileDbRow | undefined;
    return row ? rowToStored(row) : undefined;
  }

  private insertStored(stored: StoredFile): void {
    this.insertStmt.run(
      stored.metadata.id,
      stored.workspace_id,
      stored.visibility,
      stored.kind,
      stored.scope_id,
      stored.relative_path ?? null,
      stored.metadata.filename,
      stored.metadata.mime_type,
      stored.metadata.size_bytes,
      stored.metadata.created_at,
      stored.metadata.downloadable ? 1 : 0,
      JSON.stringify(stored.metadata.scope),
      stored.storage_key,
      stored.sha256,
    );
  }

  private sessionOutputFiles(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): StoredFile[] {
    return (
      this.sessionOutputsStmt.all(workspaceId, sessionId) as unknown as FileDbRow[]
    ).map(rowToStored);
  }

  private workspaceBytes(workspaceId: WorkspaceId): number {
    const row = this.workspaceBytesStmt.get(workspaceId) as
      | { total: number }
      | undefined;
    return row?.total ?? 0;
  }

  private deletePublicRow(
    workspaceId: WorkspaceId,
    fileId: string,
  ): FileDbRow | undefined {
    return this.withTransaction(() => {
      const row = this.retrievePublicStmt.get(
        workspaceId,
        fileId,
      ) as unknown as FileDbRow | undefined;
      if (!row) return undefined;
      this.deletePublicStmt.run(workspaceId, fileId);
      return row;
    });
  }

  private deleteInternalRow(
    workspaceId: WorkspaceId,
    fileId: string,
  ): FileDbRow | undefined {
    return this.withTransaction(() => {
      const row = this.retrieveInternalStmt.get(
        workspaceId,
        fileId,
      ) as unknown as FileDbRow | undefined;
      if (!row) return undefined;
      this.deleteInternalStmt.run(workspaceId, fileId);
      return row;
    });
  }

  private writeObjectSync(bytes: Uint8Array): {
    storageKey: string;
    path: string;
  } {
    const storageKey = `${randomUUID()}.bin`;
    const tmpPath = resolve(this.tmpDir, `${storageKey}.tmp`);
    const finalPath = this.objectPath(storageKey);
    writeFileSync(tmpPath, bytes, { mode: 0o600 });
    renameSync(tmpPath, finalPath);
    return { storageKey, path: finalPath };
  }

  private withTransaction<T>(fn: () => T): T {
    return withSqliteTransaction(this.db, fn);
  }

  private objectPath(storageKey: string): string {
    const path = resolve(this.objectsDir, storageKey);
    if (!path.startsWith(`${this.objectsDir}/`)) {
      throw new Error(`Invalid file storage key: ${storageKey}`);
    }
    return path;
  }

  private sweepTempAndOrphanedObjects(): void {
    rmSync(this.tmpDir, { recursive: true, force: true });
    mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
    const liveKeys = new Set(
      (this.db.prepare("SELECT storage_key FROM files").all() as Array<{
        storage_key: string;
      }>).map((row) => row.storage_key),
    );
    for (const entry of readdirSync(this.objectsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!liveKeys.has(entry.name)) {
        unlinkSync(resolve(this.objectsDir, entry.name));
      }
    }
  }
}

function publicListSql(cursorPredicate: string, order: "ASC" | "DESC"): string {
  return `
    SELECT * FROM files
    WHERE workspace_id = ? AND visibility = 'public' AND scope_id IS NULL
      ${cursorPredicate}
    ORDER BY id ${order}
    LIMIT ?
  `;
}

function sessionOutputListSql(
  cursorPredicate: string,
  order: "ASC" | "DESC",
): string {
  return `
    SELECT * FROM files
    WHERE workspace_id = ? AND visibility = 'public'
      AND kind = 'session_output' AND scope_id = ?
      ${cursorPredicate}
    ORDER BY id ${order}
    LIMIT ?
  `;
}

function rowToStored(row: FileDbRow): StoredFile {
  return {
    workspace_id: row.workspace_id,
    visibility: row.visibility,
    kind: row.kind,
    scope_id: row.scope_id,
    relative_path: row.relative_path ?? undefined,
    storage_key: row.storage_key,
    sha256: row.sha256,
    bytes: new Uint8Array(),
    metadata: {
      id: row.id,
      type: "file",
      filename: row.filename,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      created_at: row.created_at,
      downloadable: row.downloadable === 1,
      scope: JSON.parse(row.scope) as StoredFile["metadata"]["scope"],
    },
  };
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") {
      throw error;
    }
  }
}
