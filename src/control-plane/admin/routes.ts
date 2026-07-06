import { Hono } from "hono";
import { invalidRequest } from "../errors.ts";
import { parseJsonBody } from "../http.ts";
import type { ControlPlaneRouteEnv } from "../workspace.ts";
import type { AdminService } from "./service.ts";

export function adminRoutes(service: AdminService): Hono<ControlPlaneRouteEnv> {
  const app = new Hono<ControlPlaneRouteEnv>();

  app.post("/workspaces", async (c) => {
    const body = await parseJsonBody(c.req);
    return c.json(service.createWorkspace(body), 201);
  });

  app.get("/workspaces", (c) => {
    return c.json(service.listWorkspaces(), 200);
  });

  app.get("/workspaces/:id", (c) => {
    return c.json(service.getWorkspace(c.req.param("id")), 200);
  });

  app.post("/workspaces/:id/keys", async (c) => {
    const body = await parseOptionalJsonBody(c.req);
    return c.json(service.mintKey(c.req.param("id"), body), 201);
  });

  app.get("/workspaces/:id/keys", (c) => {
    return c.json(service.listKeys(c.req.param("id")), 200);
  });

  app.delete("/keys/:sha256", (c) => {
    return c.json(service.revokeKey(c.req.param("sha256")), 200);
  });

  return app;
}

async function parseOptionalJsonBody(req: {
  header(name: string): string | undefined;
  text(): Promise<string>;
}): Promise<unknown> {
  const text = await req.text();
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw invalidRequest("Request body must be valid JSON", String(error));
  }
}
