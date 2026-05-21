import { Hono } from "hono";
import { parseJsonBody, parseLimit, parseOrder } from "../http.ts";
import { invalidRequest } from "../errors.ts";
import { DEFAULT_WORKSPACE_ID } from "../workspace.ts";
import type { SessionEventsService } from "./types.ts";

export function sessionEventsRoutes(service: SessionEventsService): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const sessionId = requiredSessionId(c.req.param("sessionId"));
    const body = await parseJsonBody(c.req);
    return c.json(
      {
        data: service.send(DEFAULT_WORKSPACE_ID, sessionId, body),
      },
      200,
    );
  });

  app.get("/", (c) => {
    const sessionId = requiredSessionId(c.req.param("sessionId"));
    const limit = parseLimit(c.req.query("limit"));
    const page = parsePage(c.req.query("page"));
    const order = parseOrder(c.req.query("order"));
    const types = parseTypesQuery(c.req.url);
    return c.json(
      service.list(DEFAULT_WORKSPACE_ID, sessionId, {
        ...(limit === undefined ? {} : { limit }),
        ...(page === undefined ? {} : { page }),
        ...(order === undefined ? {} : { order }),
        ...(types.length === 0 ? {} : { types }),
      }),
      200,
    );
  });

  return app;
}

function requiredSessionId(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw invalidRequest("Session ID path parameter is required");
  }
  return value;
}

function parsePage(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (!value.startsWith("sevt_")) {
    throw invalidRequest("`page` must be a valid event cursor");
  }
  return value;
}

function parseTypesQuery(url: string): string[] {
  const params = new URL(url).searchParams;
  const values = params.getAll("types[]");
  return values.filter((value) => value.length > 0);
}
