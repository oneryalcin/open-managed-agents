import { Hono } from "hono";
import { File as NodeFile } from "node:buffer";
import { invalidRequest } from "../errors.ts";
import { parseLimit } from "../http.ts";
import { DEFAULT_WORKSPACE_ID } from "../workspace.ts";
import type { FileService } from "./types.ts";

export function filesRoutes(service: FileService): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!isUploadedFile(file)) {
      throw invalidRequest("`file` is required");
    }
    const uploaded = await service.upload(DEFAULT_WORKSPACE_ID, {
      filename: file.name,
      mimeType: file.type,
      body: new Uint8Array(await file.arrayBuffer()),
    });
    return c.json(uploaded, 200);
  });

  app.get("/", async (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const afterId = c.req.query("after_id") || undefined;
    const beforeId = c.req.query("before_id") || undefined;
    const scopeId = c.req.query("scope_id") || undefined;
    return c.json(
      await service.list(DEFAULT_WORKSPACE_ID, {
        ...(limit === undefined ? {} : { limit }),
        ...(afterId === undefined ? {} : { afterId }),
        ...(beforeId === undefined ? {} : { beforeId }),
        ...(scopeId === undefined ? {} : { scopeId }),
      }),
      200,
    );
  });

  app.get("/:id", async (c) => {
    return c.json(
      await service.retrieveMetadata(DEFAULT_WORKSPACE_ID, c.req.param("id")),
      200,
    );
  });

  app.get("/:id/content", async (c) => {
    await service.download(DEFAULT_WORKSPACE_ID, c.req.param("id"));
  });

  app.delete("/:id", async (c) => {
    return c.json(
      await service.delete(DEFAULT_WORKSPACE_ID, c.req.param("id")),
      200,
    );
  });

  return app;
}

function isUploadedFile(value: unknown): value is NodeFile {
  return (
    value instanceof NodeFile ||
    (
      typeof value === "object" &&
      value !== null &&
      "arrayBuffer" in value &&
      typeof value.arrayBuffer === "function" &&
      "name" in value &&
      typeof value.name === "string" &&
      "type" in value &&
      typeof value.type === "string"
    )
  );
}
