import { createHash } from "node:crypto";
import { invalidRequest } from "../errors.ts";
import type {
  FileStorageRecord,
  SessionOutputFileInput,
  StoredFile,
} from "./types.ts";

export function reusableOutput(
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

export async function consumeUploadBody(
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

export function validateOutputFilename(filename: string, maxBytes: number): void {
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

export function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isSafeInteger(limit) || limit <= 0) return 20;
  return Math.min(limit, 1000);
}

export function limitLabel(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  return `${bytes} bytes`;
}

export function toRecord(stored: StoredFile): FileStorageRecord {
  return {
    workspace_id: stored.workspace_id,
    storage_key: stored.storage_key,
    sha256: stored.sha256,
    metadata: { ...stored.metadata },
  };
}

export function compareRecords(a: FileStorageRecord, b: FileStorageRecord): number {
  return compareId(a.metadata.id, b.metadata.id);
}

export function compareId(a: string, b: string): number {
  return a.localeCompare(b);
}
