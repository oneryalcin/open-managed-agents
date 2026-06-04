import { createHash, randomUUID } from "node:crypto";
import { invalidRequest } from "../errors.ts";
import { newFileId } from "../ids.ts";
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

export class InMemoryFileStorage implements FileStorage {
  private readonly files = new Map<string, StoredFile>();
  private readonly workspaceBytes = new Map<WorkspaceId, number>();
  private readonly maxUploadedFileBytes: number;
  private readonly maxWorkspaceFileBytes: number;
  private readonly maxSessionOutputFiles: number;
  private readonly maxSessionOutputFileBytes: number;
  private readonly maxSessionOutputBytes: number;
  private readonly maxSessionOutputFilenameBytes: number;

  constructor(
    opts: {
      maxUploadedFileBytes?: number;
      maxWorkspaceFileBytes?: number;
      maxSessionOutputFiles?: number;
      maxSessionOutputFileBytes?: number;
      maxSessionOutputBytes?: number;
      maxSessionOutputFilenameBytes?: number;
    } = {},
  ) {
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
      storageKeySegment: "",
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
      storageKeySegment: "internal/",
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
      storageKeySegment: string;
      fileId: string | undefined;
      downloadable: boolean;
      relativePath: string | undefined;
      maxBytes: number;
    },
  ): Promise<FileStorageRecord> {
    const { bytes, sizeBytes, sha256 } = await consumeUploadBody(
      input.body,
      opts.maxBytes,
      "Uploaded file",
    );
    const currentWorkspaceBytes = this.workspaceBytes.get(workspaceId) ?? 0;
    if (currentWorkspaceBytes + sizeBytes > this.maxWorkspaceFileBytes) {
      throw invalidRequest(
        `Workspace file storage exceeds the ${limitLabel(this.maxWorkspaceFileBytes)} in-memory limit`,
      );
    }

    const id = opts.fileId ?? newFileId();
    if (this.files.has(id)) {
      throw invalidRequest(`File ${id} already exists`);
    }
    const now = new Date().toISOString();
    const stored: StoredFile = {
      visibility: opts.visibility,
      kind: opts.kind,
      workspace_id: workspaceId,
      storage_key: `memory://${workspaceId}/${opts.storageKeySegment}${id}/${randomUUID()}`,
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
    this.files.set(id, stored);
    this.workspaceBytes.set(workspaceId, currentWorkspaceBytes + sizeBytes);
    return toRecord(stored);
  }

  async retrieveMetadata(
    workspaceId: WorkspaceId,
    fileId: string,
  ): Promise<FileStorageRecord | undefined> {
    const stored = this.files.get(fileId);
    if (
      !stored ||
      stored.workspace_id !== workspaceId ||
      stored.visibility !== "public"
    ) {
      return undefined;
    }
    return toRecord(stored);
  }

  async openBytes(
    workspaceId: WorkspaceId,
    fileId: string,
  ): Promise<AsyncIterable<Uint8Array> | undefined> {
    const stored = this.files.get(fileId);
    if (
      !stored ||
      stored.workspace_id !== workspaceId ||
      stored.visibility !== "public"
    ) {
      return undefined;
    }
    return singleChunk(stored.bytes);
  }

  async openInternalSnapshotBytes(
    workspaceId: WorkspaceId,
    fileId: string,
  ): Promise<AsyncIterable<Uint8Array> | undefined> {
    const stored = this.files.get(fileId);
    if (
      !stored ||
      stored.workspace_id !== workspaceId ||
      stored.visibility !== "internal"
    ) {
      return undefined;
    }
    return singleChunk(stored.bytes);
  }

  async delete(workspaceId: WorkspaceId, fileId: string): Promise<boolean> {
    const stored = this.files.get(fileId);
    if (
      !stored ||
      stored.workspace_id !== workspaceId ||
      stored.visibility !== "public"
    ) {
      return false;
    }
    this.deleteStored(workspaceId, fileId, stored);
    return true;
  }

  async deleteInternalSnapshot(
    workspaceId: WorkspaceId,
    fileId: string,
  ): Promise<boolean> {
    const stored = this.files.get(fileId);
    if (
      !stored ||
      stored.workspace_id !== workspaceId ||
      stored.visibility !== "internal"
    ) {
      return false;
    }
    this.deleteStored(workspaceId, fileId, stored);
    return true;
  }

  async replaceSessionOutputs(
    workspaceId: WorkspaceId,
    sessionId: string,
    files: readonly SessionOutputFileInput[],
  ): Promise<readonly FileStorageRecord[]> {
    if (files.length > this.maxSessionOutputFiles) {
      throw invalidRequest(
        `Session output collection exceeds the ${this.maxSessionOutputFiles} file limit`,
      );
    }
    const oldOutputs = this.sessionOutputFiles(workspaceId, sessionId);
    const reusableOutputByRelativePath = new Map(
      oldOutputs
        .filter((stored) => stored.relative_path !== undefined)
        .map((stored) => [stored.relative_path!, stored]),
    );
    const basenameOwners = new Map<string, string>();
    const prepared: StoredFile[] = [];
    let totalOutputBytes = 0;
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
      const reusable = reusableOutput(
        reusableOutputByRelativePath.get(file.relativePath),
        file,
        sizeBytes,
        sha256,
      );
      const id = reusable?.metadata.id ?? newFileId();
      const createdAt = reusable?.metadata.created_at ?? new Date().toISOString();
      prepared.push({
        visibility: "public",
        kind: "session_output",
        workspace_id: workspaceId,
        storage_key:
          reusable?.storage_key ??
          `memory://${workspaceId}/outputs/${sessionId}/${id}/${randomUUID()}`,
        sha256,
        bytes,
        scope_id: sessionId,
        relative_path: file.relativePath,
        metadata: {
          id,
          type: "file",
          filename: file.filename,
          mime_type: file.mimeType,
          size_bytes: sizeBytes,
          created_at: createdAt,
          downloadable: true,
          scope: { type: "session", id: sessionId },
        },
      });
    }

    const oldBytes = oldOutputs.reduce(
      (sum, stored) => sum + stored.metadata.size_bytes,
      0,
    );
    const currentWorkspaceBytes = this.workspaceBytes.get(workspaceId) ?? 0;
    if (currentWorkspaceBytes - oldBytes + totalOutputBytes > this.maxWorkspaceFileBytes) {
      throw invalidRequest(
        `Workspace file storage exceeds the ${limitLabel(this.maxWorkspaceFileBytes)} in-memory limit`,
      );
    }

    for (const stored of oldOutputs) {
      this.files.delete(stored.metadata.id);
    }
    for (const stored of prepared) {
      this.files.set(stored.metadata.id, stored);
    }
    this.workspaceBytes.set(
      workspaceId,
      currentWorkspaceBytes - oldBytes + totalOutputBytes,
    );
    return prepared.map(toRecord).sort(compareRecords);
  }

  async deleteSessionOutputs(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<void> {
    for (const stored of this.sessionOutputFiles(workspaceId, sessionId)) {
      this.deleteStored(workspaceId, stored.metadata.id, stored);
    }
  }

  private deleteStored(
    workspaceId: WorkspaceId,
    fileId: string,
    stored: StoredFile,
  ): void {
    this.files.delete(fileId);
    this.workspaceBytes.set(
      workspaceId,
      Math.max(
        0,
        (this.workspaceBytes.get(workspaceId) ?? 0) -
          stored.metadata.size_bytes,
      ),
    );
  }

  async list(
    workspaceId: WorkspaceId,
    opts: FileListOptions = {},
  ): Promise<FileStoragePage> {
    const limit = normalizeLimit(opts.limit);
    const rows = [...this.files.values()]
      .filter((file) => file.workspace_id === workspaceId)
      .filter((file) => file.visibility === "public")
      .filter((file) =>
        opts.scopeId === undefined
          ? file.scope_id === null
          : file.kind === "session_output" && file.scope_id === opts.scopeId,
      )
      .map(toRecord)
      .sort(compareRecords);
    const cursorRows =
      opts.beforeId !== undefined
        ? rows.filter((row) => compareId(row.metadata.id, opts.beforeId!) < 0)
        : opts.afterId !== undefined
          ? rows.filter((row) => compareId(row.metadata.id, opts.afterId!) > 0)
          : rows;
    const pageRows =
      opts.beforeId === undefined
        ? cursorRows.slice(0, limit)
        : cursorRows.slice(-limit);
    return {
      data: pageRows,
      has_more: cursorRows.length > limit,
      first_id: pageRows[0]?.metadata.id ?? null,
      last_id: pageRows[pageRows.length - 1]?.metadata.id ?? null,
    };
  }

  getInternalRecordForTest(fileId: string): FileStorageRecord | undefined {
    const stored = this.files.get(fileId);
    return stored ? toRecord(stored) : undefined;
  }

  getWorkspaceBytesForTest(workspaceId: WorkspaceId): number {
    return this.workspaceBytes.get(workspaceId) ?? 0;
  }

  getSessionOutputRecordsForTest(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): readonly FileStorageRecord[] {
    return this.sessionOutputFiles(workspaceId, sessionId)
      .map(toRecord)
      .sort(compareRecords);
  }

  private sessionOutputFiles(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): StoredFile[] {
    return [...this.files.values()].filter(
      (file) =>
        file.workspace_id === workspaceId &&
        file.visibility === "public" &&
        file.kind === "session_output" &&
        file.scope_id === sessionId,
    );
  }
}

function reusableOutput(
  stored: StoredFile | undefined,
  file: SessionOutputFileInput,
  sizeBytes: number,
  sha256: string,
): StoredFile | undefined {
  if (!stored) return undefined;
  if (stored.sha256 !== sha256) return undefined;
  if (stored.metadata.size_bytes !== sizeBytes) return undefined;
  if (stored.metadata.filename !== file.filename) return undefined;
  return stored;
}

async function consumeUploadBody(
  body: AsyncIterable<Uint8Array> | Uint8Array,
  maxBytes: number,
  label: string,
): Promise<{ bytes: Uint8Array; sizeBytes: number; sha256: string }> {
  const hash = createHash("sha256");
  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;
  for await (const chunk of chunksOf(body)) {
    sizeBytes += chunk.byteLength;
    if (sizeBytes > maxBytes) {
      throw invalidRequest(
        `${label} exceeds the ${limitLabel(maxBytes)} per-file limit`,
      );
    }
    hash.update(chunk);
    chunks.push(chunk);
  }
  return {
    bytes: concat(chunks, sizeBytes),
    sizeBytes,
    sha256: hash.digest("hex"),
  };
}

function validateOutputFilename(filename: string, maxBytes: number): void {
  const bytes = new TextEncoder().encode(filename).byteLength;
  if (bytes === 0) {
    throw invalidRequest("Session output filename must not be empty");
  }
  if (filename.includes("/") || filename.includes("\\")) {
    throw invalidRequest(`Session output filename must be a basename: ${filename}`);
  }
  if (bytes > maxBytes) {
    throw invalidRequest(
      `Session output filename exceeds the ${maxBytes} byte limit`,
    );
  }
}

async function* chunksOf(
  body: AsyncIterable<Uint8Array> | Uint8Array,
): AsyncIterable<Uint8Array> {
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  for await (const chunk of body) {
    yield chunk;
  }
}

function concat(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function* singleChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isSafeInteger(limit) || limit <= 0) return 20;
  return Math.min(limit, 1000);
}

function limitLabel(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  return `${bytes} bytes`;
}

function emptyPage(): FileStoragePage {
  return {
    data: [],
    has_more: false,
    first_id: null,
    last_id: null,
  };
}

function toRecord(stored: StoredFile): FileStorageRecord {
  return {
    workspace_id: stored.workspace_id,
    storage_key: stored.storage_key,
    sha256: stored.sha256,
    metadata: { ...stored.metadata },
  };
}

function compareRecords(a: FileStorageRecord, b: FileStorageRecord): number {
  return compareId(a.metadata.id, b.metadata.id);
}

function compareId(a: string, b: string): number {
  return a.localeCompare(b);
}
