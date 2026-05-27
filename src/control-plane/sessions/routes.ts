import { Hono } from "hono";
import { parseJsonBody, parseLimit, parseOrder } from "../http.ts";
import { invalidRequest } from "../errors.ts";
import { DEFAULT_WORKSPACE_ID } from "../workspace.ts";
import type { SessionEventsService } from "../events/types.ts";
import type { SessionService } from "./types.ts";

export function sessionsRoutes(
  service: SessionService,
  events: SessionEventsService,
): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = await parseJsonBody(c.req);
    const session = service.create(DEFAULT_WORKSPACE_ID, body);
    return c.json(session, 200);
  });

  app.get("/", (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const page = c.req.query("page") || undefined;
    const order = parseOrder(c.req.query("order"));
    const agentId = c.req.query("agent_id") || undefined;
    const includeArchived = parseBoolean(c.req.query("include_archived"));
    return c.json(
      service.list(DEFAULT_WORKSPACE_ID, {
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
      service.retrieve(DEFAULT_WORKSPACE_ID, c.req.param("id")),
      200,
    );
  });

  app.post("/:id/archive", async (c) => {
    const sessionId = c.req.param("id");
    const before = service.retrieve(DEFAULT_WORKSPACE_ID, sessionId);
    const session = service.archive(DEFAULT_WORKSPACE_ID, sessionId);
    await events.archiveSession(DEFAULT_WORKSPACE_ID, sessionId, {
      emitTerminalEvent:
        before.archived_at === null && before.status !== "terminated",
    });
    return c.json(session, 200);
  });

  app.delete("/:id", async (c) => {
    const sessionId = c.req.param("id");
    const deleted = service.delete(DEFAULT_WORKSPACE_ID, sessionId);
    await events.deleteSession(DEFAULT_WORKSPACE_ID, sessionId);
    return c.json(deleted, 200);
  });

  return app;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalidRequest("`include_archived` must be `true` or `false`");
}
