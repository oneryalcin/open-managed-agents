import { Hono } from "hono";
import { parseJsonBody, parseLimit } from "../http.ts";
import { workspaceIdFrom, type ControlPlaneRouteEnv } from "../workspace.ts";
import type { VaultService } from "./types.ts";

export function vaultsRoutes(service: VaultService): Hono<ControlPlaneRouteEnv> {
  const app = new Hono<ControlPlaneRouteEnv>();

  app.post("/", async (c) => {
    const body = await parseJsonBody(c.req);
    return c.json(service.createVault(workspaceIdFrom(c), body), 200);
  });

  app.get("/", (c) => {
    return c.json(
      service.listVaults(workspaceIdFrom(c), listOpts((key) => c.req.query(key))),
      200,
    );
  });

  app.get("/:vaultId", (c) => {
    return c.json(
      service.retrieveVault(workspaceIdFrom(c), c.req.param("vaultId")),
      200,
    );
  });

  app.post("/:vaultId/archive", (c) => {
    return c.json(
      service.archiveVault(workspaceIdFrom(c), c.req.param("vaultId")),
      200,
    );
  });

  app.post("/:vaultId", async (c) => {
    const body = await parseJsonBody(c.req);
    return c.json(
      service.updateVault(workspaceIdFrom(c), c.req.param("vaultId"), body),
      200,
    );
  });

  app.delete("/:vaultId", (c) => {
    return c.json(
      service.deleteVault(workspaceIdFrom(c), c.req.param("vaultId")),
      200,
    );
  });

  app.post("/:vaultId/credentials", async (c) => {
    const body = await parseJsonBody(c.req);
    return c.json(
      service.createCredential(
        workspaceIdFrom(c),
        c.req.param("vaultId"),
        body,
      ),
      200,
    );
  });

  app.get("/:vaultId/credentials", (c) => {
    return c.json(
      service.listCredentials(
        workspaceIdFrom(c),
        c.req.param("vaultId"),
        listOpts((key) => c.req.query(key)),
      ),
      200,
    );
  });

  app.post("/:vaultId/credentials/:credentialId/archive", (c) => {
    return c.json(
      service.archiveCredential(
        workspaceIdFrom(c),
        c.req.param("vaultId"),
        c.req.param("credentialId"),
      ),
      200,
    );
  });

  app.get("/:vaultId/credentials/:credentialId", (c) => {
    return c.json(
      service.retrieveCredential(
        workspaceIdFrom(c),
        c.req.param("vaultId"),
        c.req.param("credentialId"),
      ),
      200,
    );
  });

  app.post("/:vaultId/credentials/:credentialId", async (c) => {
    const body = await parseJsonBody(c.req);
    return c.json(
      service.updateCredential(
        workspaceIdFrom(c),
        c.req.param("vaultId"),
        c.req.param("credentialId"),
        body,
      ),
      200,
    );
  });

  app.delete("/:vaultId/credentials/:credentialId", (c) => {
    service.deleteCredential(
      workspaceIdFrom(c),
      c.req.param("vaultId"),
      c.req.param("credentialId"),
    );
    return c.body(null, 204);
  });

  return app;
}

function listOpts(query: (key: string) => string | undefined): {
  limit?: number;
  page?: string;
  includeArchived?: boolean;
} {
  const limit = parseLimit(query("limit"));
  const page = query("page") || undefined;
  const includeArchived = query("include_archived") === "true";
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(page === undefined ? {} : { page }),
    ...(includeArchived ? { includeArchived } : {}),
  };
}
