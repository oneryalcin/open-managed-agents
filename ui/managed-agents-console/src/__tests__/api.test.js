import { describe, expect, it } from "vitest";
import { buildRequestHeaders, clearKeyForPath } from "../api.js";

// The console's credential-routing contract (plan 0120 §3.3): the admin key
// rides /admin requests only, the workspace key /v1 only. A bug that crossed
// the tiers would hand the root credential to workspace-scoped routes (or
// vice versa) on every request the console makes.

const BOTH = { adminKey: "admin-secret", workspaceKey: "oma_workspace" };

describe("buildRequestHeaders", () => {
  it("sends only x-admin-key on /admin paths", () => {
    const headers = buildRequestHeaders("/admin/workspaces", BOTH);
    expect(headers["x-admin-key"]).toBe("admin-secret");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
  });

  it("sends only x-api-key plus the beta header on /v1 paths", () => {
    const headers = buildRequestHeaders("/v1/agents", BOTH);
    expect(headers["x-api-key"]).toBe("oma_workspace");
    expect(headers["x-admin-key"]).toBeUndefined();
    expect(headers["anthropic-beta"]).toContain("managed-agents-2026-04-01");
  });

  it("does not treat /administrator or /v1x as credentialed paths", () => {
    // Prefix sloppiness (startsWith("/admin")) would leak the admin key to
    // any path sharing the prefix.
    expect(buildRequestHeaders("/administrator", BOTH)).toEqual({
      accept: "application/json",
    });
    expect(buildRequestHeaders("/v1x/agents", BOTH)).toEqual({
      accept: "application/json",
    });
  });

  it("omits credential headers when no key is set", () => {
    const none = { adminKey: null, workspaceKey: null };
    expect(buildRequestHeaders("/admin/workspaces", none)["x-admin-key"])
      .toBeUndefined();
    expect(buildRequestHeaders("/v1/agents", none)["x-api-key"])
      .toBeUndefined();
  });
});

describe("clearKeyForPath", () => {
  it("clears only the admin key after an /admin 401", () => {
    const creds = { ...BOTH };
    clearKeyForPath("/admin/workspaces", creds);
    expect(creds.adminKey).toBeNull();
    expect(creds.workspaceKey).toBe(BOTH.workspaceKey);
  });

  it("clears only the workspace key after a /v1 401", () => {
    const creds = { ...BOTH };
    clearKeyForPath("/v1/agents", creds);
    expect(creds.workspaceKey).toBeNull();
    expect(creds.adminKey).toBe(BOTH.adminKey);
  });
});
