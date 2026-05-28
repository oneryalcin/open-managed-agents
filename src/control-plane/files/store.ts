import { createHash, randomUUID } from "node:crypto";
import { invalidRequest } from "../errors.ts";
import { newFileId } from "../ids.ts";
import type {
  FileListOptions,
  FileStorage,
  FileStoragePage,
  FileStorageRecord,
  StoredFile,
  UploadedFileInput,
  WorkspaceId,
} from "./types.ts";
import {
  MAX_UPLOADED_FILE_BYTES,
  MAX_WORKSPACE_FILE_BYTES,
} from "./types.ts";

export class InMemoryFileStorage implements FileStorage {
  private readonly files = new Map<string, StoredFile>();
  private readonly workspaceBytes = new Map<WorkspaceId, number>();
  private readonly maxUploadedFileBytes: number;
  private readonly maxWorkspaceFileBytes: number;

  constructor(
    opts: {
      maxUploadedFileBytes?: number;
      maxWorkspaceFileBytes?: number;
    } = {},
  ) {
    this.maxUploadedFileBytes =
      opts.maxUploadedFileBytes ?? MAX_UPLOADED_FILE_BYTES;
    this.maxWorkspaceFileBytes =
      opts.maxWorkspaceFileBytes ?? MAX_WORKSPACE_FILE_BYTES;
  }

  async create(
    workspaceId: WorkspaceId,
    input: UploadedFileInput,
  ): Promise<FileStorageRecord> {
    return this.createStored(workspaceId, input, {
      visibility: "public",
      scope: null,
      storageKeySegment: "",
    });
  }

  async createInternalSnapshot(
    workspaceId: WorkspaceId,
    input: UploadedFileInput & { scopeId: string },
  ): Promise<FileStorageRecord> {
    return this.createStored(workspaceId, input, {
      visibility: "internal",
      scope: input.scopeId,
      storageKeySegment: "internal/",
    });
  }

  private async createStored(
    workspaceId: WorkspaceId,
    input: UploadedFileInput,
    opts: {
      visibility: StoredFile["visibility"];
      scope: string | null;
      storageKeySegment: string;
    },
  ): Promise<FileStorageRecord> {
    const { bytes, sizeBytes, sha256 } = await consumeUploadBody(
      input.body,
      this.maxUploadedFileBytes,
    );
    const currentWorkspaceBytes = this.workspaceBytes.get(workspaceId) ?? 0;
    if (currentWorkspaceBytes + sizeBytes > this.maxWorkspaceFileBytes) {
      throw invalidRequest(
        `Workspace file storage exceeds the ${limitLabel(this.maxWorkspaceFileBytes)} in-memory limit`,
      );
    }

    const id = newFileId();
    const now = new Date().toISOString();
    const stored: StoredFile = {
      visibility: opts.visibility,
      workspace_id: workspaceId,
      storage_key: `memory://${workspaceId}/${opts.storageKeySegment}${id}/${randomUUID()}`,
      sha256,
      bytes,
      metadata: {
        id,
        type: "file",
        filename: input.filename,
        mime_type: input.mimeType,
        size_bytes: sizeBytes,
        created_at: now,
        downloadable: false,
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
    if (opts.scopeId !== undefined) {
      return emptyPage();
    }
    const rows = [...this.files.values()]
      .filter((file) => file.workspace_id === workspaceId)
      .filter((file) => file.visibility === "public")
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
}

async function consumeUploadBody(
  body: AsyncIterable<Uint8Array> | Uint8Array,
  maxUploadedFileBytes: number,
): Promise<{ bytes: Uint8Array; sizeBytes: number; sha256: string }> {
  const hash = createHash("sha256");
  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;
  for await (const chunk of chunksOf(body)) {
    sizeBytes += chunk.byteLength;
    if (sizeBytes > maxUploadedFileBytes) {
      throw invalidRequest(
        `Uploaded file exceeds the ${limitLabel(maxUploadedFileBytes)} per-file limit`,
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
