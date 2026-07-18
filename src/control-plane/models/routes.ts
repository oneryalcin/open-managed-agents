import { Hono } from "hono";
import { invalidRequest } from "../errors.ts";
import { parseLimit } from "../http.ts";
import { workspaceIdFrom, type ControlPlaneRouteEnv } from "../workspace.ts";
import type { ModelCatalogService } from "./service.ts";

export function modelCatalogRoutes(
  service: ModelCatalogService,
): Hono<ControlPlaneRouteEnv> {
  const app = new Hono<ControlPlaneRouteEnv>();

  app.get("/", (c) => {
    return c.json(
      service.list(workspaceIdFrom(c), {
        provider: nonEmptyQuery(c.req.query("provider"), "provider"),
        available: parseAvailable(c.req.query("available")),
        limit: parseLimit(c.req.query("limit")),
        page: nonEmptyQuery(c.req.query("page"), "page"),
      }),
      200,
    );
  });

  return app;
}

function nonEmptyQuery(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0) throw invalidRequest(`\`${name}\` must not be empty`);
  return value;
}

function parseAvailable(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalidRequest("`available` must be `true` or `false`");
}
