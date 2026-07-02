import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { File as NodeFile } from "node:buffer";
import {
  invalidRequest,
  requestTooLarge,
  toApiErrorBody,
  type ApiErrorBody,
} from "../errors.ts";
import { parseLimit } from "../http.ts";
import { workspaceIdFrom, type ControlPlaneRouteEnv } from "../workspace.ts";
import type { AdmissionLimits } from "../admission.ts";
import type { FileService } from "./types.ts";

export const MAX_FILE_UPLOAD_REQUEST_BYTES = 24 * 1024 * 1024;

export function filesRoutes(
  service: FileService,
  admission?: AdmissionLimits,
): Hono<ControlPlaneRouteEnv> {
  const app = new Hono<ControlPlaneRouteEnv>();

  // 0113 D9: the upload slot must be reserved BEFORE bodyLimit. For requests
  // without a content-length, Hono's bodyLimit eagerly reads the raw body
  // into a wrapped stream, so a gate placed after it (or in the handler)
  // admits up to 24 MiB of buffering per rejected request.
  app.use("/", async (c, next) => {
    if (c.req.method !== "POST" || admission === undefined) {
      await next();
      return;
    }
    const releaseUpload = admission.uploads.acquire(workspaceIdFrom(c));
    try {
      await next();
    } finally {
      releaseUpload();
    }
  });

  app.use(
    "/",
    bodyLimit({
      maxSize: MAX_FILE_UPLOAD_REQUEST_BYTES,
      onError: (c) => {
        const err = requestTooLarge();
        return jsonError(toApiErrorBody(err, c.get("requestId")), err.status);
      },
    }),
  );

  app.post("/", async (c) => {
    const body = await parseMultipartBody(c.req);
    const file = body.file;
    if (!isUploadedFile(file)) {
      throw invalidRequest("`file` is required");
    }
    const uploaded = await service.upload(workspaceIdFrom(c), {
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
      await service.list(workspaceIdFrom(c), {
        limit,
        afterId,
        beforeId,
        scopeId,
      }),
      200,
    );
  });

  app.get("/:id", async (c) => {
    return c.json(
      await service.retrieveMetadata(workspaceIdFrom(c), c.req.param("id")),
      200,
    );
  });

  app.get("/:id/content", async (c) => {
    const download = await service.download(
      workspaceIdFrom(c),
      c.req.param("id"),
    );
    return new Response(asyncIterableToReadableStream(download.body), {
      status: 200,
      headers: {
        "content-type": download.mimeType,
        "content-length": String(download.sizeBytes),
        "request-id": c.get("requestId"),
      },
    });
  });

  app.delete("/:id", async (c) => {
    return c.json(
      await service.delete(workspaceIdFrom(c), c.req.param("id")),
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

async function parseMultipartBody(req: {
  parseBody(): Promise<Record<string, string | File>>;
}): Promise<Record<string, string | File>> {
  try {
    return await req.parseBody();
  } catch (error) {
    throw invalidRequest("Request body must be valid multipart/form-data", String(error));
  }
}

function jsonError(body: ApiErrorBody, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "request-id": body.request_id,
    },
  });
}

function asyncIterableToReadableStream(
  body: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      await iterator.throw?.(reason);
    },
  });
}
