import { afterEach, describe, expect, it, vi } from "vitest";
import { __testRequest, buildRequestHeaders, clearKeyForPath, listVaultCredentials, listVaults, mintKey, validateMcpOauthCredential } from "../api.js";

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

describe("mintKey in-flight dedup", () => {
  afterEach(() => vi.unstubAllGlobals());

  const okResponse = () => ({
    ok: true,
    status: 201,
    text: () => Promise.resolve(JSON.stringify({ api_key: "oma_x" })),
  });

  it("coalesces a double-click into one POST (an orphaned second key would stay active unseen)", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const fetchMock = vi.fn(() => gate.then(okResponse));
    vi.stubGlobal("fetch", fetchMock);

    const first = mintKey("wrk_a", "label");
    const second = mintKey("wrk_a"); // while the first is still in flight
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
  });

  it("allows a fresh mint once the previous one settled", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse()));
    vi.stubGlobal("fetch", fetchMock);
    await mintKey("wrk_a");
    await mintKey("wrk_a");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not couple mints for different workspaces", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const fetchMock = vi.fn(() => gate.then(okResponse));
    vi.stubGlobal("fetch", fetchMock);
    const a = mintKey("wrk_a");
    const b = mintKey("wrk_b");
    release();
    await Promise.all([a, b]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

describe("workspace write capability", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects generic /v1 writes before a network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const attempt of [
      { path: "/v1/sessions", method: "POST", body: {} },
      { path: "/v1/agents", method: "POST", body: {} },
      { path: "/v1/vaults/a", method: "DELETE" },
      { path: "/v1/vaults/a/credentials/b/archive", method: "POST" },
      { path: "/v1/vaults/a/credentials/b/mcp_oauth_validate", method: "DELETE" },
    ]) {
      await expect(__testRequest(attempt.path, attempt)).rejects.toThrow("not permitted");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let method casing bypass the write guard", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // fetch() is case-insensitive on the method, so a lowercase verb must not
    // slip past the deny-by-default gate.
    await expect(__testRequest("/v1/sessions", { method: "post", body: {} })).rejects.toThrow("not permitted");
    await expect(__testRequest("/v1/vaults/a", { method: "Delete" })).rejects.toThrow("not permitted");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows only the exact validation wrapper in API mode", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok:true, status:200, text:() => Promise.resolve("{}") }));
    vi.stubGlobal("fetch", fetchMock);
    await validateMcpOauthCredential("vault/a", "credential/b", "api");
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/vaults/vault%2Fa/credentials/credential%2Fb/mcp_oauth_validate",
      expect.objectContaining({ method:"POST" }),
    );
    await expect(validateMcpOauthCredential("a", "b", "mock")).rejects.toThrow("live API mode");
  });

  it("reads vault lists with archived rows included", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok:true, status:200, text:() => Promise.resolve(JSON.stringify({ data:[], has_more:false, next_page:null })) }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { origin: "http://oma.local" } });
    await listVaults();
    await listVaultCredentials("vlt/1");
    const urls = fetchMock.mock.calls.map((call) => call[0]);
    expect(urls[0]).toContain("/v1/vaults?");
    expect(urls[0]).toContain("include_archived=true");
    expect(urls[1]).toContain("/v1/vaults/vlt%2F1/credentials?");
    expect(urls[1]).toContain("include_archived=true");
  });
});
