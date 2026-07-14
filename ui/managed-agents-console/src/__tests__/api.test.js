import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testRequest,
  buildRequestHeaders,
  clearCredentials,
  clearKeyForPath,
  createAgent,
  createEnvironment,
  createIdempotencyIntent,
  createSession,
  followSessionEvents,
  hasWorkspaceKey,
  listVaultCredentials,
  listVaults,
  mintKey,
  sendSessionEvents,
  setWorkspaceKey,
  toUiSessionEvent,
  validateMcpOauthCredential,
} from "../api.js";

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
  afterEach(() => {
    clearCredentials();
    vi.unstubAllGlobals();
  });

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

  it("treats the write guard as case-insensitive on the method", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // The guard is fail-closed for any casing; this pins that a lowercase or
    // mixed-case verb stays denied and never reaches fetch (so a future edit to
    // the capability clause can't make case load-bearing).
    await expect(__testRequest("/v1/sessions", { method: "post", body: {} })).rejects.toThrow("not permitted");
    await expect(__testRequest("/v1/vaults/a", { method: "Delete" })).rejects.toThrow("not permitted");
    await expect(__testRequest("/v1/vaults/a/credentials/b/mcp_oauth_validate", { method: "post" })).rejects.toThrow("not permitted");
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

  it("creates agents through the narrow wrapper with workspace auth, beta, and JSON headers", async () => {
    setWorkspaceKey("oma_workspace");
    const fetchMock = vi.fn(() => Promise.resolve({
      ok:true,
      status:200,
      text:() => Promise.resolve(JSON.stringify({
        id:"agent_1234567890",
        type:"agent",
        name:"Console agent",
        model:{ id:"claude-sonnet-4-6", speed:"standard" },
        system:"Be concise.",
        tools:[{ type:"agent_toolset_20260401" }],
        version:1,
        created_at:"2026-07-14T10:00:00Z",
        updated_at:"2026-07-14T10:00:00Z",
        archived_at:null,
      })),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createAgent({
      name:"Console agent",
      model:"claude-sonnet-4-6",
      system:"Be concise.",
      tools:[{ type:"agent_toolset_20260401" }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/agents",
      expect.objectContaining({
        method:"POST",
        headers:expect.objectContaining({
          accept:"application/json",
          "x-api-key":"oma_workspace",
          "anthropic-beta":expect.stringContaining("managed-agents-2026-04-01"),
          "content-type":"application/json",
        }),
        body:JSON.stringify({
          name:"Console agent",
          model:"claude-sonnet-4-6",
          system:"Be concise.",
          tools:[{ type:"agent_toolset_20260401" }],
        }),
      }),
    );
  });

  it("creates environments through the narrow wrapper without an idempotency key", async () => {
    setWorkspaceKey("oma_workspace");
    const fetchMock = vi.fn(() => Promise.resolve({
      ok:true,
      status:200,
      text:() => Promise.resolve(JSON.stringify({
        id:"env_1234567890",
        type:"environment",
        name:"Console env",
        config:{ type:"cloud" },
        created_at:"2026-07-14T10:00:00Z",
        updated_at:"2026-07-14T10:00:00Z",
        archived_at:null,
      })),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createEnvironment({ name:"Console env", config:{ type:"cloud" } });

    expect(fetchMock.mock.calls[0][0]).toBe("/v1/environments");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(fetchMock.mock.calls[0][1].headers["idempotency-key"]).toBeUndefined();
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({
      name:"Console env",
      config:{ type:"cloud" },
    }));
  });

  it("creates sessions with a reused idempotency key for the same intent and rotates when the payload changes", async () => {
    setWorkspaceKey("oma_workspace");
    const fetchMock = vi.fn(() => Promise.resolve({
      ok:true,
      status:200,
      text:() => Promise.resolve(JSON.stringify({
        id:"sesn_1234567890",
        type:"session",
        agent:{ type:"agent", id:"agent_1", version:1 },
        environment_id:"env_1",
        vault_ids:[],
        status:"idle",
        title:null,
        metadata:{},
        created_at:"2026-07-14T10:00:00Z",
        updated_at:"2026-07-14T10:00:00Z",
        archived_at:null,
        usage:null,
        resources:[],
      })),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const intent = createIdempotencyIntent();

    await createSession({ agent:"agent_1", environment_id:"env_1" }, { intent });
    await createSession({ agent:"agent_1", environment_id:"env_1" }, { intent });
    await createSession({ agent:"agent_1", environment_id:"env_2" }, { intent });

    const keys = fetchMock.mock.calls.map((call) => call[1].headers["idempotency-key"]);
    expect(keys[0]).toMatch(/[0-9a-f-]{36}/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({
      agent:"agent_1",
      environment_id:"env_1",
    }));
  });

  it("sends session events with the supported envelope and idempotency rotation", async () => {
    setWorkspaceKey("oma_workspace");
    const fetchMock = vi.fn(() => Promise.resolve({
      ok:true,
      status:200,
      text:() => Promise.resolve(JSON.stringify({ data:[], has_more:false })),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const intent = createIdempotencyIntent();
    const message = { type:"user.message", content:[{ type:"text", text:"Hello" }] };

    await sendSessionEvents("sesn/a", [message], { intent });
    await sendSessionEvents("sesn/a", [message], { intent });
    await sendSessionEvents("sesn/a", [{ type:"user.interrupt" }], { intent });

    expect(fetchMock.mock.calls[0][0]).toBe("/v1/sessions/sesn%2Fa/events");
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ events:[message] }));
    const keys = fetchMock.mock.calls.map((call) => call[1].headers["idempotency-key"]);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("follows session event streams with authenticated headers and no URL credentials", async () => {
    setWorkspaceKey("oma_workspace");
    const fetchMock = vi.fn(() => Promise.resolve({
      ok:false,
      status:401,
      body:null,
    }));
    await expect(followSessionEvents("sesn/a", {
      fetchImpl: fetchMock,
      onEvent: vi.fn(),
      lastEventId: "sevt_1",
      maxReconnects: 0,
    })).rejects.toThrow("Session event stream failed (401)");

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/sessions/sesn%2Fa/events/stream",
      expect.objectContaining({
        method:"GET",
        headers:expect.objectContaining({
          accept:"text/event-stream",
          "x-api-key":"oma_workspace",
          "anthropic-beta":expect.stringContaining("managed-agents-2026-04-01"),
          "last-event-id":"sevt_1",
        }),
      }),
    );
    expect(fetchMock.mock.calls[0][0]).not.toContain("oma_workspace");
    expect(hasWorkspaceKey()).toBe(false);
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

describe("session event UI mapping", () => {
  it("keeps MCP confirmation metadata actionable", () => {
    const event = toUiSessionEvent({
      id:"sevt_mcp",
      type:"agent.mcp_tool_use",
      processed_at:"2026-07-14T10:00:00Z",
      mcp_server_name:"github",
      name:"create_issue",
      input:{ title:"Alpha" },
      evaluated_permission:"ask",
    });
    expect(event).toMatchObject({
      id:"sevt_mcp",
      role:"tool",
      transcript:true,
      confirm:true,
      tool:"create_issue",
    });
    expect(event.cmd).toContain("Alpha");
  });
});
