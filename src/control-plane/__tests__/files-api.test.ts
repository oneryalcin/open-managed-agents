import { File } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  MAX_REQUEST_BODY_BYTES,
  createInMemoryControlPlaneApp,
} from "../app.ts";
import { MAX_FILE_UPLOAD_REQUEST_BYTES } from "../files/routes.ts";
import type { ApiErrorBody } from "../errors.ts";
import type { ManagedAgentsFileMetadata } from "../../types/files.ts";

describe("files API", () => {
  it("uploads, retrieves, lists, and deletes uploaded input files", async () => {
    const app = createInMemoryControlPlaneApp();

    const created = await uploadFile(app, {
      filename: "probe.txt",
      mimeType: "text/plain",
      content: "OMA_FILE_PROBE=ok\n",
    });
    expect(created).toEqual({
      id: expect.stringMatching(/^file_/),
      type: "file",
      filename: "probe.txt",
      mime_type: "text/plain",
      size_bytes: 18,
      created_at: expect.any(String),
      downloadable: false,
      scope: null,
    });
    expect(JSON.stringify(created)).not.toContain("memory://");

    const retrievedRes = await app.request(`/v1/files/${created.id}`);
    expect(retrievedRes.status).toBe(200);
    await expect(retrievedRes.json()).resolves.toEqual(created);

    const listRes = await app.request("/v1/files?limit=10");
    expect(listRes.status).toBe(200);
    await expect(listRes.json()).resolves.toEqual({
      data: [created],
      has_more: false,
      first_id: created.id,
      last_id: created.id,
    });

    const deletedRes = await app.request(`/v1/files/${created.id}`, {
      method: "DELETE",
    });
    expect(deletedRes.status).toBe(200);
    await expect(deletedRes.json()).resolves.toEqual({
      id: created.id,
      type: "file_deleted",
    });

    const missingRes = await app.request(`/v1/files/${created.id}`);
    expect(missingRes.status).toBe(404);
  });

  it("rejects public download for uploaded input files without leaking storage keys", async () => {
    const app = createInMemoryControlPlaneApp();
    const created = await uploadFile(app, {
      filename: "private.txt",
      mimeType: "text/plain",
      content: "private",
    });

    const res = await app.request(`/v1/files/${created.id}/content`);

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error).toEqual({
      type: "invalid_request_error",
      message: `File '${created.id}' is not downloadable`,
    });
    expect(JSON.stringify(body)).not.toContain("memory://");
  });

  it("accepts executable MIME types as recorded metadata", async () => {
    const app = createInMemoryControlPlaneApp();

    const created = await uploadFile(app, {
      filename: "tool.bin",
      mimeType: "application/x-executable",
      content: "not really executable",
    });

    expect(created.mime_type).toBe("application/x-executable");
  });

  it("returns distinct file ids for duplicate uploads", async () => {
    const app = createInMemoryControlPlaneApp();

    const one = await uploadFile(app, {
      filename: "same.txt",
      mimeType: "text/plain",
      content: "same",
    });
    const two = await uploadFile(app, {
      filename: "same.txt",
      mimeType: "text/plain",
      content: "same",
    });

    expect(one.id).not.toBe(two.id);
  });

  it("does not expose internal storage keys on public surfaces", async () => {
    const app = createInMemoryControlPlaneApp();
    const created = await uploadFile(app, {
      filename: "surface.txt",
      mimeType: "text/plain",
      content: "surface",
    });
    const responses = [
      created,
      await jsonFrom(app.request(`/v1/files/${created.id}`)),
      await jsonFrom(app.request("/v1/files")),
      await jsonFrom(app.request(`/v1/files/${created.id}/content`)),
      await jsonFrom(app.request("/v1/files/file_missing")),
    ];

    for (const response of responses) {
      expect(JSON.stringify(response)).not.toContain("memory://");
      expect(JSON.stringify(response)).not.toContain("storage_key");
    }
  });

  it("rejects missing multipart file payloads", async () => {
    const app = createInMemoryControlPlaneApp();
    const res = await app.request("/v1/files", {
      method: "POST",
      body: new FormData(),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error).toEqual({
      type: "invalid_request_error",
      message: "`file` is required",
    });
  });

  it("returns invalid_request_error for malformed multipart bodies", async () => {
    const app = createInMemoryControlPlaneApp();
    const res = await app.request("/v1/files", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=broken",
      },
      body: "--not-the-boundary\r\nbroken",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error).toEqual({
      type: "invalid_request_error",
      message: "Request body must be valid multipart/form-data",
    });
  });

  it("keeps the large upload body limit scoped to files", async () => {
    const app = createInMemoryControlPlaneApp();

    const oversizedJsonRes = await app.request("/v1/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
      },
      body: "{}",
    });
    expect(oversizedJsonRes.status).toBe(413);

    const form = new FormData();
    const fileRes = await app.request("/v1/files", {
      method: "POST",
      headers: {
        "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
      },
      body: form,
    });

    expect(fileRes.status).toBe(400);
    const body = (await fileRes.json()) as ApiErrorBody;
    expect(body.error).toEqual({
      type: "invalid_request_error",
      message: "`file` is required",
    });
    expect(MAX_REQUEST_BODY_BYTES + 1).toBeLessThan(MAX_FILE_UPLOAD_REQUEST_BYTES);
  });

  it("paginates before_id and after_id through the HTTP layer", async () => {
    const app = createInMemoryControlPlaneApp();
    const files = [];
    for (const name of ["a", "b", "c", "d", "e"]) {
      files.push(
        await uploadFile(app, {
          filename: `${name}.txt`,
          mimeType: "text/plain",
          content: name,
        }),
      );
    }
    files.sort((a, b) => a.id.localeCompare(b.id));
    const [a, b, c, d] = files;

    const beforeRes = await app.request(`/v1/files?before_id=${d!.id}&limit=2`);
    expect(beforeRes.status).toBe(200);
    await expect(beforeRes.json()).resolves.toMatchObject({
      data: [b, c],
      has_more: true,
      first_id: b!.id,
      last_id: c!.id,
    });

    const afterRes = await app.request(`/v1/files?after_id=${a!.id}&limit=2`);
    expect(afterRes.status).toBe(200);
    await expect(afterRes.json()).resolves.toMatchObject({
      data: [b, c],
      has_more: true,
      first_id: b!.id,
      last_id: c!.id,
    });
  });
});

async function uploadFile(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
  input: {
    filename: string;
    mimeType: string;
    content: string;
  },
): Promise<ManagedAgentsFileMetadata> {
  const form = new FormData();
  form.set(
    "file",
    new File([input.content], input.filename, { type: input.mimeType }),
  );
  const res = await app.request("/v1/files", {
    method: "POST",
    body: form,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsFileMetadata;
}

async function jsonFrom(response: Response | Promise<Response>): Promise<unknown> {
  const res = await response;
  return res.json();
}
