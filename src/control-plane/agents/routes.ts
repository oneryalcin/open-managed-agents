import { Hono } from "hono";
import { invalidRequest } from "../errors.ts";
import { parseJsonBody, parseLimit } from "../http.ts";
import { DEFAULT_WORKSPACE_ID, type AgentService } from "./types.ts";

export function agentsRoutes(service: AgentService): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = await parseJsonBody(c.req);
    const agent = service.create(DEFAULT_WORKSPACE_ID, body);
    return c.json(agent, 200);
  });

  app.get("/", (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const page = c.req.query("page") || undefined;
    const includeArchived = parseBoolean(c.req.query("include_archived"));
    return c.json(
      service.list(DEFAULT_WORKSPACE_ID, {
        ...(limit === undefined ? {} : { limit }),
        ...(page === undefined ? {} : { page }),
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

  return app;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalidRequest("`include_archived` must be `true` or `false`");
}
