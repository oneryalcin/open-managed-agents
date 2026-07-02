import { Hono } from "hono";
import { parseJsonBody, parseLimit, parseOrder } from "../http.ts";
import { invalidRequest } from "../errors.ts";
import {
  requestFingerprint,
  validateIdempotencyKey,
} from "../request-idempotency.ts";
import { workspaceIdFrom, type ControlPlaneRouteEnv } from "../workspace.ts";
import type { SessionEventsService } from "../events/types.ts";
import { toManagedSession } from "./serialize.ts";
import type { SessionService } from "./types.ts";

type AppEnv = ControlPlaneRouteEnv;

export function sessionsRoutes(
  service: SessionService,
  events: SessionEventsService,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/", async (c) => {
    const idempotencyKey = c.req.header("idempotency-key");
    if (idempotencyKey !== undefined) {
      const rawBody = new Uint8Array(await c.req.raw.arrayBuffer());
      const body = parseJsonBytes(rawBody);
      const method = c.req.method.toUpperCase();
      const concretePath = new URL(c.req.url).pathname;
      const response = await service.createIdempotent(
        workspaceIdFrom(c),
        body,
        {
          method,
          concretePath,
          key: validateIdempotencyKey(idempotencyKey),
          routeLabel: "POST /v1/sessions",
          fingerprintSha256: requestFingerprint(method, concretePath, rawBody),
        },
        { requestId: c.get("requestId") },
      );
      return jsonResponse(
        response.body,
        response.status,
        c.get("requestId"),
        response.headers,
      );
    }
    const body = await parseJsonBody(c.req);
    const session = await service.create(workspaceIdFrom(c), body);
    return c.json(session, 200);
  });

  app.get("/", (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const page = c.req.query("page") || undefined;
    const order = parseOrder(c.req.query("order"));
    const agentId = c.req.query("agent_id") || undefined;
    const includeArchived = parseBoolean(c.req.query("include_archived"));
    return c.json(
      service.list(workspaceIdFrom(c), {
        ...(limit === undefined ? {} : { limit }),
        ...(page === undefined ? {} : { page }),
        ...(order === undefined ? {} : { order }),
        ...(agentId === undefined ? {} : { agentId }),
        ...(includeArchived === undefined ? {} : { includeArchived }),
      }),
      200,
    );
  });

  app.get("/:id", (c) => {
    return c.json(
      service.retrieve(workspaceIdFrom(c), c.req.param("id")),
      200,
    );
  });

  app.post("/:id/archive", async (c) => {
    const sessionId = c.req.param("id");
    const row = events.archiveSessionRowAfterPreflight(
      workspaceIdFrom(c),
      sessionId,
    );
    await events.archiveSession(workspaceIdFrom(c), sessionId);
    return c.json(toManagedSession(row), 200);
  });

  app.delete("/:id", async (c) => {
    const sessionId = c.req.param("id");
    const deleted = await service.delete(workspaceIdFrom(c), sessionId);
    await events.deleteSession(workspaceIdFrom(c), sessionId);
    return c.json(deleted, 200);
  });

  return app;
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw invalidRequest("Request body must be valid JSON", String(error));
  }
}

function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "request-id": requestId,
      ...extraHeaders,
    },
  });
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalidRequest("`include_archived` must be `true` or `false`");
}
