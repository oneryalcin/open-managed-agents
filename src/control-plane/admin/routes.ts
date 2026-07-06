import { Hono } from "hono";
import { invalidRequest } from "../errors.ts";
import { parseJsonBody } from "../http.ts";
import { log } from "../logging.ts";
import type { ControlPlaneRouteEnv } from "../workspace.ts";
import type { AdminService } from "./service.ts";

export function adminRoutes(service: AdminService): Hono<ControlPlaneRouteEnv> {
  const app = new Hono<ControlPlaneRouteEnv>();

  app.post("/workspaces", async (c) => {
    const body = await parseJsonBody(c.req);
    const workspace = service.createWorkspace(body);
    emitAdminAudit(c.get("requestId"), {
      action: "create_workspace",
      workspace_id: workspace.id,
    });
    return c.json(workspace, 201);
  });

  app.get("/workspaces", (c) => {
    return c.json(service.listWorkspaces(), 200);
  });

  app.get("/workspaces/:id", (c) => {
    return c.json(service.getWorkspace(c.req.param("id")), 200);
  });

  app.post("/workspaces/:id/keys", async (c) => {
    const body = await parseOptionalJsonBody(c.req);
    const minted = service.mintKey(c.req.param("id"), body);
    emitAdminAudit(c.get("requestId"), {
      action: "mint_key",
      workspace_id: minted.workspace_id,
      key_sha256: minted.key_sha256,
    });
    return c.json(minted, 201);
  });

  app.get("/workspaces/:id/keys", (c) => {
    return c.json(service.listKeys(c.req.param("id")), 200);
  });

  app.delete("/keys/:sha256", (c) => {
    const revoked = service.revokeKey(c.req.param("sha256"));
    emitAdminAudit(c.get("requestId"), {
      action: "revoke_key",
      workspace_id: revoked.workspace_id,
      key_sha256: revoked.key_sha256,
      revoked_at: revoked.revoked_at,
    });
    return c.json(revoked, 200);
  });

  return app;
}

function emitAdminAudit(
  requestId: string,
  event: {
    action: "create_workspace" | "mint_key" | "revoke_key";
    workspace_id: string;
    key_sha256?: string;
    revoked_at?: string | null;
  },
): void {
  // Wire shape predates the structured logger; `type: "admin_audit"` is the
  // grep contract and stays (0121 C1 — the logger adds ts/level/event around
  // it). Emitted at the audit level: OMA_LOG_LEVEL must never be able to
  // silence the admin audit trail.
  log.audit("admin_audit", {
    type: "admin_audit",
    request_id: requestId,
    ...event,
  });
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
