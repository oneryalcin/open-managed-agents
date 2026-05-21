import { Hono } from "hono";
import { invalidRequest } from "../errors.ts";
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

async function parseJsonBody(req: {
  json(): Promise<unknown>;
}): Promise<unknown> {
  try {
    return await req.json();
  } catch (error) {
    throw invalidRequest("Request body must be valid JSON", String(error));
  }
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw invalidRequest("`limit` must be a positive integer");
  }
  return limit;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalidRequest("`include_archived` must be `true` or `false`");
}
