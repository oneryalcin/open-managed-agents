import { describe, expect, it } from "vitest";
import { DefaultFileService } from "../service.ts";
import { InMemoryFileStorage } from "../store.ts";
import type { WorkspaceId } from "../../workspace.ts";

const WORKSPACE_A: WorkspaceId = "wrk_a";
const WORKSPACE_B: WorkspaceId = "wrk_b";

describe("FileService + InMemoryFileStorage", () => {
  it("stores uploaded file metadata with internal sha256 while keeping keys private", async () => {
    const storage = new InMemoryFileStorage();
    const service = new DefaultFileService(storage);

    const metadata = await service.upload(WORKSPACE_A, {
      filename: "probe.txt",
      mimeType: "text/plain",
      body: bytes("hello\n"),
    });

    expect(metadata).toEqual({
      id: expect.stringMatching(/^file_/),
      type: "file",
      filename: "probe.txt",
      mime_type: "text/plain",
      size_bytes: 6,
      created_at: expect.any(String),
      downloadable: false,
      scope: null,
    });
    expect(metadata).not.toHaveProperty("workspace_id");
    expect(metadata).not.toHaveProperty("storage_key");
    expect(metadata).not.toHaveProperty("sha256");

    const internal = storage.getInternalRecordForTest(metadata.id);
    expect(internal?.sha256).toBe(
      "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
    );
    expect(internal?.storage_key).toMatch(/^memory:\/\/wrk_a\/file_/);
  });

  it("accepts executable MIME types as metadata-only", async () => {
    const service = new DefaultFileService(new InMemoryFileStorage());

    const metadata = await service.upload(WORKSPACE_A, {
      filename: "tool.bin",
      mimeType: "application/x-executable",
      body: bytes("not really executable"),
    });

    expect(metadata.mime_type).toBe("application/x-executable");
  });

  it("creates distinct ids for duplicate uploads", async () => {
    const service = new DefaultFileService(new InMemoryFileStorage());

    const one = await service.upload(WORKSPACE_A, {
      filename: "same.txt",
      mimeType: "text/plain",
      body: bytes("same"),
    });
    const two = await service.upload(WORKSPACE_A, {
      filename: "same.txt",
      mimeType: "text/plain",
      body: bytes("same"),
    });

    expect(one.id).not.toBe(two.id);
  });

  it("returns the page adjacent to before_id when paginating backward", async () => {
    const service = new DefaultFileService(new InMemoryFileStorage());
    const files = [];
    for (const name of ["a", "b", "c", "d", "e"]) {
      files.push(
        await service.upload(WORKSPACE_A, {
          filename: `${name}.txt`,
          mimeType: "text/plain",
          body: bytes(name),
        }),
      );
    }
    files.sort((a, b) => a.id.localeCompare(b.id));
    const [a, b, c, d] = files;

    await expect(
      service.list(WORKSPACE_A, { beforeId: d!.id, limit: 2 }),
    ).resolves.toMatchObject({
      data: [b, c],
      has_more: true,
      first_id: b!.id,
      last_id: c!.id,
    });
    await expect(
      service.list(WORKSPACE_A, { afterId: a!.id, limit: 2 }),
    ).resolves.toMatchObject({
      data: [b, c],
      has_more: true,
      first_id: b!.id,
      last_id: c!.id,
    });
  });

  it("scopes metadata, bytes, lists, and deletes by workspace", async () => {
    const storage = new InMemoryFileStorage();
    const service = new DefaultFileService(storage);
    const metadata = await service.upload(WORKSPACE_A, {
      filename: "secret.txt",
      mimeType: "text/plain",
      body: bytes("secret"),
    });

    await expect(service.retrieveMetadata(WORKSPACE_B, metadata.id)).rejects.toThrow(
      `File ${metadata.id} not found`,
    );
    await expect(storage.openBytes(WORKSPACE_B, metadata.id)).resolves.toBeUndefined();
    await expect(service.list(WORKSPACE_B)).resolves.toMatchObject({ data: [] });
    await expect(service.delete(WORKSPACE_B, metadata.id)).rejects.toThrow(
      `File ${metadata.id} not found`,
    );
    await expect(service.retrieveMetadata(WORKSPACE_A, metadata.id)).resolves.toEqual(
      metadata,
    );
  });

  it("does not persist partial metadata or quota after an interrupted upload stream", async () => {
    const service = new DefaultFileService(new InMemoryFileStorage());

    await expect(
      service.upload(WORKSPACE_A, {
        filename: "broken.txt",
        mimeType: "text/plain",
        body: interruptedBody(),
      }),
    ).rejects.toThrow("stream interrupted");
    await expect(service.list(WORKSPACE_A)).resolves.toMatchObject({
      data: [],
      has_more: false,
    });

    const retry = await service.upload(WORKSPACE_A, {
      filename: "broken.txt",
      mimeType: "text/plain",
      body: bytes("retry-ok"),
    });

    expect(retry.size_bytes).toBe(8);
    await expect(service.list(WORKSPACE_A)).resolves.toMatchObject({
      data: [retry],
      has_more: false,
    });
  });

  it("enforces per-file and per-workspace byte limits before committing records", async () => {
    const storage = new InMemoryFileStorage({
      maxUploadedFileBytes: 5,
      maxWorkspaceFileBytes: 10,
    });
    const service = new DefaultFileService(storage);

    await expect(
      service.upload(WORKSPACE_A, {
        filename: "too-large.bin",
        mimeType: "application/octet-stream",
        body: new Uint8Array(6),
      }),
    ).rejects.toThrow("5 bytes per-file limit");
    expect(storage.getWorkspaceBytesForTest(WORKSPACE_A)).toBe(0);

    for (const index of [0, 1]) {
      await service.upload(WORKSPACE_A, {
        filename: `chunk-${index}.bin`,
        mimeType: "application/octet-stream",
        body: new Uint8Array(5),
      });
    }
    await expect(
      service.upload(WORKSPACE_A, {
        filename: "overflow.bin",
        mimeType: "application/octet-stream",
        body: bytes("x"),
      }),
    ).rejects.toThrow("10 bytes in-memory limit");
    expect(storage.getWorkspaceBytesForTest(WORKSPACE_A)).toBe(10);
  });

  it("stores internal session snapshots against quota without public metadata leakage", async () => {
    const storage = new InMemoryFileStorage({
      maxWorkspaceFileBytes: 10,
    });
    const service = new DefaultFileService(storage);
    const uploaded = await service.upload(WORKSPACE_A, {
      filename: "input.txt",
      mimeType: "text/plain",
      body: bytes("input"),
    });

    const snapshot = await storage.createInternalSnapshot(WORKSPACE_A, {
      fileId: "file_precomputed_snapshot",
      filename: "probe.txt",
      mimeType: "text/plain",
      scopeId: "sesn_123",
      body: bytes("snap"),
    });

    expect(snapshot.metadata.id).toBe("file_precomputed_snapshot");
    expect(snapshot.metadata.scope).toBe("sesn_123");
    expect(storage.getWorkspaceBytesForTest(WORKSPACE_A)).toBe(9);
    await expect(service.list(WORKSPACE_A)).resolves.toMatchObject({
      data: [uploaded],
    });
    await expect(service.list(WORKSPACE_A, { scopeId: "sesn_123" })).resolves.toMatchObject({
      data: [],
    });
    await expect(service.retrieveMetadata(WORKSPACE_A, snapshot.metadata.id)).rejects.toThrow(
      `File ${snapshot.metadata.id} not found`,
    );

    const chunks = [];
    const stream = await storage.openInternalSnapshotBytes(
      WORKSPACE_A,
      snapshot.metadata.id,
    );
    for await (const chunk of stream ?? []) {
      chunks.push(chunk);
    }
    expect(new TextDecoder().decode(concat(chunks))).toBe("snap");

    await expect(
      storage.createInternalSnapshot(WORKSPACE_A, {
        fileId: "file_overflow_snapshot",
        filename: "overflow.txt",
        mimeType: "text/plain",
        scopeId: "sesn_123",
        body: bytes("xx"),
      }),
    ).rejects.toThrow("10 bytes in-memory limit");
    expect(storage.getWorkspaceBytesForTest(WORKSPACE_A)).toBe(9);
    await expect(
      storage.createInternalSnapshot(WORKSPACE_A, {
        fileId: snapshot.metadata.id,
        filename: "duplicate.txt",
        mimeType: "text/plain",
        scopeId: "sesn_123",
        body: bytes("x"),
      }),
    ).rejects.toThrow(`File ${snapshot.metadata.id} already exists`);
    expect(storage.getWorkspaceBytesForTest(WORKSPACE_A)).toBe(9);

    await expect(
      storage.deleteInternalSnapshot(WORKSPACE_A, snapshot.metadata.id),
    ).resolves.toBe(true);
    expect(storage.getWorkspaceBytesForTest(WORKSPACE_A)).toBe(5);
  });
});

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function* interruptedBody(): AsyncIterable<Uint8Array> {
  yield bytes("partial");
  throw new Error("stream interrupted");
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
