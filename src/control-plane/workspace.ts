import type { Context } from "hono";

export const DEFAULT_WORKSPACE_ID = "wrk_default";

export type WorkspaceId = string;

// Shared Hono env for every control-plane route module. Auth middleware sets
// `workspaceId`; when auth is disabled (or for a module unit-tested in
// isolation) it is absent and requests resolve to the default workspace,
// preserving pre-auth behavior. Plan 0113 D4: all routes read the workspace
// through workspaceIdFrom(c) — no ad hoc c.get() casts.
export interface ControlPlaneRouteEnv {
  Variables: {
    requestId: string;
    workspaceId?: WorkspaceId;
  };
}

export function workspaceIdFrom(c: Context<ControlPlaneRouteEnv>): WorkspaceId {
  return c.get("workspaceId") ?? DEFAULT_WORKSPACE_ID;
}
