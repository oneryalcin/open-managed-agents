import { Hono } from "hono";
import { parseJsonBody, parseLimit } from "../http.ts";
import { DEFAULT_WORKSPACE_ID } from "../workspace.ts";
import type { EnvironmentService } from "./types.ts";

export function environmentsRoutes(service: EnvironmentService): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = await parseJsonBody(c.req);
    const environment = service.create(DEFAULT_WORKSPACE_ID, body);
    return c.json(environment, 200);
  });

  app.get("/", (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const page = c.req.query("page") || undefined;
    return c.json(
      service.list(DEFAULT_WORKSPACE_ID, {
        ...(limit === undefined ? {} : { limit }),
        ...(page === undefined ? {} : { page }),
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
