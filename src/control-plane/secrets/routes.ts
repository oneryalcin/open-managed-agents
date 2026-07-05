import { Hono } from "hono";
import { parseJsonBody } from "../http.ts";
import { workspaceIdFrom, type ControlPlaneRouteEnv } from "../workspace.ts";
import type { SecretsService } from "./service.ts";

// OMA-specific surface (plan 0117e-2): POST upserts { name, value } and
// returns metadata only — no route ever returns a secret value.
export function secretsRoutes(service: SecretsService): Hono<ControlPlaneRouteEnv> {
  const app = new Hono<ControlPlaneRouteEnv>();

  app.post("/", async (c) => {
    const body = await parseJsonBody(c.req);
    return c.json(service.create(workspaceIdFrom(c), body), 201);
  });

  app.get("/", (c) => {
    return c.json(service.list(workspaceIdFrom(c)), 200);
  });

  app.delete("/:name", (c) => {
    service.delete(workspaceIdFrom(c), c.req.param("name"));
    return c.body(null, 204);
  });

  return app;
}
