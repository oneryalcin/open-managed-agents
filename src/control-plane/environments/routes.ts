import { Hono } from "hono";
import { parseJsonBody, parseLimit } from "../http.ts";
import { workspaceIdFrom, type ControlPlaneRouteEnv } from "../workspace.ts";
import type { EnvironmentService } from "./types.ts";

export function environmentsRoutes(service: EnvironmentService): Hono<ControlPlaneRouteEnv> {
  const app = new Hono<ControlPlaneRouteEnv>();

  app.post("/", async (c) => {
    const body = await parseJsonBody(c.req);
    const environment = service.create(workspaceIdFrom(c), body);
    return c.json(environment, 200);
  });

  app.get("/", (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const page = c.req.query("page") || undefined;
    return c.json(
      service.list(workspaceIdFrom(c), {
        ...(limit === undefined ? {} : { limit }),
        ...(page === undefined ? {} : { page }),
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

  return app;
}
