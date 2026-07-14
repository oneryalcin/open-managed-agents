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

  app.get("/:id/versions", (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const page = c.req.query("page") || undefined;
    return c.json(service.listVersions(
      workspaceIdFrom(c),
      c.req.param("id"),
      {
        ...(limit === undefined ? {} : { limit }),
        ...(page === undefined ? {} : { page }),
      },
    ), 200);
  });

  app.get("/:id", (c) => {
    const version = parsePositiveInteger(c.req.query("version"), "version");
    return c.json(
      service.retrieve(workspaceIdFrom(c), c.req.param("id"), version),
      200,
    );
  });

  app.post("/:id", async (c) => {
    const body = await parseJsonBody(c.req);
    return c.json(service.update(workspaceIdFrom(c), c.req.param("id"), body), 200);
  });

  app.post("/:id/archive", (c) => {
    return c.json(
      service.archive(workspaceIdFrom(c), c.req.param("id")),
      200,
    );
  });

  return app;
}

function parsePositiveInteger(
  value: string | undefined,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw invalidRequest(`\`${field}\` must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidRequest(`\`${field}\` must be a positive integer`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalidRequest("`include_archived` must be `true` or `false`");
}
