import { Hono } from "hono";
import { invalidRequest } from "../errors.ts";
import { parseJsonBody, parseLimit } from "../http.ts";
import { workspaceIdFrom, type ControlPlaneRouteEnv } from "../workspace.ts";
import type { AgentService } from "./types.ts";

export function agentsRoutes(service: AgentService): Hono<ControlPlaneRouteEnv> {
  const app = new Hono<ControlPlaneRouteEnv>();

  app.post("/", async (c) => {
    const body = await parseJsonBody(c.req);
    const agent = service.create(workspaceIdFrom(c), body);
    return c.json(agent, 200);
  });

  app.get("/", (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const page = c.req.query("page") || undefined;
    const includeArchived = parseBoolean(c.req.query("include_archived"));
    return c.json(
      service.list(workspaceIdFrom(c), {
        ...(limit === undefined ? {} : { limit }),
        ...(page === undefined ? {} : { page }),
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

  app.post("/:id/archive", (c) => {
    return c.json(
      service.archive(workspaceIdFrom(c), c.req.param("id")),
      200,
    );
  });

  return app;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalidRequest("`include_archived` must be `true` or `false`");
}
