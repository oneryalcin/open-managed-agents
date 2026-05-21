import { Hono } from "hono";
import { parseJsonBody, parseLimit, parseOrder } from "../http.ts";
import { DEFAULT_WORKSPACE_ID } from "../workspace.ts";
import type { SessionService } from "./types.ts";

export function sessionsRoutes(service: SessionService): Hono {
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
    return c.json(
      service.list(DEFAULT_WORKSPACE_ID, {
        ...(limit === undefined ? {} : { limit }),
        ...(page === undefined ? {} : { page }),
        ...(order === undefined ? {} : { order }),
        ...(agentId === undefined ? {} : { agentId }),
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

  return app;
}
