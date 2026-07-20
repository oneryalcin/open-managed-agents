import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testRequest,
  archiveAgent,
  archiveSession,
  buildRequestHeaders,
  canSubmitToolConfirmation,
  clearCredentials,
  clearKeyForPath,
  createAgent,
  createSkill,
  createVault,
  createVaultCredential,
  createEnvironment,
  createIdempotencyIntent,
  createSession,
  deleteSession,
  followSessionEvents,
  hasWorkspaceKey,
  getConsoleAuthStatus,
  loginConsoleAdmin,
  loginConsoleWorkspace,
  listEnvironmentNetworkingPresets,
  listVaultCredentials,
  listVaults,
  loadConsoleData,
  listModelCatalog,
  modelInputForSelection,
  mintKey,
  sendSessionEvents,
  selectConsoleWorkspace,
  setWorkspaceKey,
  toUiSessionEvent,
  updateAgentToolPermission,
  validateEnvironmentNetworkingHosts,
  validateMcpOauthCredential,
  logoutConsole,
} from "../api.js";

describe("tool confirmation lifecycle gate", () => {
  it("allows active writable sessions and rejects archived, read-only, or busy sessions", () => {
    expect(canSubmitToolConfirmation({ status:"idle", readOnly:false, actionBusy:false })).toBe(true);
    expect(canSubmitToolConfirmation({ status:"archived", readOnly:false, actionBusy:false })).toBe(false);
    expect(canSubmitToolConfirmation({ status:"idle", readOnly:true, actionBusy:false })).toBe(false);
    expect(canSubmitToolConfirmation({ status:"idle", readOnly:false, actionBusy:true })).toBe(false);
  });
});

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
    expect(headers["anthropic-beta"]).toContain("skills-2025-10-02");
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

describe("opaque console-session transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exchanges credentials through console-only endpoints without adding raw-key headers", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok:true, status:200, text:() => Promise.resolve(JSON.stringify({ workspace:{ id:"wrk_a", name:"A" } })) }));
    vi.stubGlobal("fetch", fetchMock);
    await loginConsoleWorkspace("oma_workspace");
    await loginConsoleAdmin("admin-secret");
    await selectConsoleWorkspace("wrk_a");
    await logoutConsole();
    await getConsoleAuthStatus();
    expect(fetchMock.mock.calls).toEqual(expect.arrayContaining([
      ["/console/auth/workspace", expect.objectContaining({ method:"POST", body:JSON.stringify({ api_key:"oma_workspace" }), credentials:"same-origin", headers:expect.not.objectContaining({ "x-api-key":expect.anything(), "x-admin-key":expect.anything() }) })],
      ["/console/auth/admin", expect.objectContaining({ method:"POST", body:JSON.stringify({ admin_key:"admin-secret" }), credentials:"same-origin", headers:expect.not.objectContaining({ "x-api-key":expect.anything(), "x-admin-key":expect.anything() }) })],
      ["/console/auth/select-workspace", expect.objectContaining({ method:"POST", body:JSON.stringify({ workspace_id:"wrk_a" }) })],
      ["/console/auth/logout", expect.objectContaining({ method:"POST" })],
      ["/console/auth/status", expect.objectContaining({ method:"GET" })],
    ]));
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
      { path: "/v1/vaults", method: "POST", body: {} },
      { path: "/v1/skills", method: "POST", body: {} },
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

  it("allows only dedicated vault, credential, and multipart-skill writes", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok:true, status:200, text:() => Promise.resolve("{}") }));
    vi.stubGlobal("fetch", fetchMock);
    await createVault({ display_name:"Notion" });
    await createVaultCredential("vlt_a", { auth:{ type:"static_bearer", mcp_server_url:"https://mcp.example.test/mcp", token:"token-long-enough" } });
    await createSkill("Support", [new Blob(["---\nname: support\n---"], { type:"text/markdown" })]);
    expect(fetchMock).toHaveBeenCalledWith("/v1/vaults", expect.objectContaining({ method:"POST", body:JSON.stringify({ display_name:"Notion" }) }));
    expect(fetchMock).toHaveBeenCalledWith("/v1/vaults/vlt_a/credentials", expect.objectContaining({ method:"POST" }));
    const skillCall = fetchMock.mock.calls.find(([path]) => path === "/v1/skills");
    expect(skillCall?.[1]).toEqual(expect.objectContaining({ method:"POST", body:expect.any(FormData) }));
    expect(skillCall?.[1].headers["content-type"]).toBeUndefined();
  });

  it("allows only the exact environment networking validation wrapper", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({
      ok:true,
      status:200,
      text:() => Promise.resolve(JSON.stringify({ allowed_hosts:["registry.npmjs.org", "*.pypi.org"] })),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateEnvironmentNetworkingHosts(["registry.npmjs.org", "*.pypi.org"]))
      .resolves.toEqual(["registry.npmjs.org", "*.pypi.org"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/environments/networking-presets/validate",
      expect.objectContaining({
        method:"POST",
        body:JSON.stringify({ allowed_hosts:["registry.npmjs.org", "*.pypi.org"] }),
      }),
    );
    await expect(__testRequest("/v1/environments/networking-presets", { method:"POST", body:{} }))
      .rejects.toThrow("not permitted");
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
        tools:[{
          type:"agent_toolset_20260401",
          default_config:{ enabled:true, permission_policy:{ type:"always_allow" } },
          configs:[
            { name:"bash", enabled:true, permission_policy:{ type:"always_ask" } },
            { name:"read", enabled:false },
          ],
        }],
        version:1,
        created_at:"2026-07-14T10:00:00Z",
        updated_at:"2026-07-14T10:00:00Z",
        archived_at:null,
      })),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const created = await createAgent({
      name:"Console agent",
      model:"claude-sonnet-4-6",
      system:"Be concise.",
      tools:[{ type:"agent_toolset_20260401" }],
    });

    expect(created.toolPermission).toBe("Mixed permissions");
    expect(created.model).toBe("anthropic/claude-sonnet-4-6");

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

  it("allows only exact agent/session lifecycle routes through narrow wrappers", async () => {
    setWorkspaceKey("oma_workspace");
    const fetchMock = vi.fn((path, init) => Promise.resolve({
      ok:true,
      status:200,
      text:() => Promise.resolve(JSON.stringify(path.includes("/agents/") ? {
        id:"agent_1234567890",
        type:"agent",
        name:"Archived agent",
        model:{ provider:"anthropic", id:"claude-sonnet-5" },
        tools:[],
        version:1,
        created_at:"2026-07-14T10:00:00Z",
        updated_at:"2026-07-14T10:00:00Z",
        archived_at:"2026-07-14T11:00:00Z",
      } : { id:"sesn_1234567890", method:init.method })),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(archiveAgent("agent/a")).resolves.toMatchObject({ status:"archived" });
    await expect(archiveSession("session/a")).resolves.toMatchObject({ method:"POST" });
    await expect(deleteSession("session/a")).resolves.toMatchObject({ method:"DELETE" });

    expect(fetchMock.mock.calls.map(([path, init]) => [path, init.method])).toEqual([
      ["/v1/agents/agent%2Fa/archive", "POST"],
      ["/v1/sessions/session%2Fa/archive", "POST"],
      ["/v1/sessions/session%2Fa", "DELETE"],
    ]);

    await expect(__testRequest("/v1/agents/a/archive/extra", { method:"POST" }))
      .rejects.toThrow("not permitted");
    await expect(__testRequest("/v1/sessions/a/events", { method:"DELETE" }))
      .rejects.toThrow("not permitted");
  });

  it("creates an immutable agent revision when tool approval changes", async () => {
    setWorkspaceKey("oma_workspace");
    const rawTools = [{
      type:"agent_toolset_20260401",
      default_config:{ enabled:true, permission_policy:{ type:"always_ask" } },
      configs:[
        { name:"bash", enabled:true, permission_policy:{ type:"always_ask" } },
        { name:"write", enabled:false },
      ],
    }];
    const fetchMock = vi.fn((_path, init) => Promise.resolve({
      ok:true,
      status:200,
      text:() => Promise.resolve(JSON.stringify({
        id:"agent_1234567890",
        type:"agent",
        name:"Updated agent",
        model:{ provider:"anthropic", id:"claude-sonnet-5" },
        tools:JSON.parse(init.body).tools,
        version:4,
        created_at:"2026-07-14T10:00:00Z",
        updated_at:"2026-07-14T11:00:00Z",
        archived_at:null,
      })),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateAgentToolPermission({
      id:"agent_1234567890",
      apiVersion:3,
      rawTools,
    }, "always_allow")).resolves.toMatchObject({
      version:"v4",
      apiVersion:4,
      toolPermission:"Always allow",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/agents/agent_1234567890",
      expect.objectContaining({
        method:"POST",
        body:JSON.stringify({
          version:3,
          tools:[{
            type:"agent_toolset_20260401",
            default_config:{ enabled:true, permission_policy:{ type:"always_allow" } },
            configs:[
              { name:"bash", enabled:true, permission_policy:{ type:"always_allow" } },
              { name:"write", enabled:false },
            ],
          }],
        }),
      }),
    );

    await expect(updateAgentToolPermission({
      id:"agent_without_tools",
      apiVersion:1,
      rawTools:[],
    }, "always_allow")).rejects.toThrow("no enabled built-in tools");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves enabled tools inherited from the canonical materialized default", async () => {
    setWorkspaceKey("oma_workspace");
    const canonicalTools = [{
      type:"agent_toolset_20260401",
      default_config:{ enabled:true, permission_policy:{ type:"always_allow" } },
      configs:[
        { name:"web_fetch", enabled:false },
        { name:"web_search", enabled:false },
      ],
    }];
    const fetchMock = vi.fn((path, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      const isUpdate = path !== "/v1/agents";
      return Promise.resolve({
        ok:true,
        status:200,
        text:() => Promise.resolve(JSON.stringify({
          id:"agent_implicit_defaults",
          type:"agent",
          name:"Implicit defaults",
          model:{ provider:"anthropic", id:"claude-sonnet-5" },
          tools:isUpdate ? body.tools : canonicalTools,
          version:isUpdate ? 2 : 1,
          created_at:"2026-07-14T10:00:00Z",
          updated_at:"2026-07-14T11:00:00Z",
          archived_at:null,
        })),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const agent = await createAgent({
      name:"Implicit defaults",
      model:"claude-sonnet-5",
      tools:[{ type:"agent_toolset_20260401" }],
    });
    expect(agent.toolPermission).toBe("Always allow");

    await expect(updateAgentToolPermission(agent, "always_ask")).resolves.toMatchObject({
      version:"v2",
      toolPermission:"Ask before use",
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      version:1,
      tools:[{
        type:"agent_toolset_20260401",
        default_config:{ enabled:true, permission_policy:{ type:"always_ask" } },
        configs:[
          { name:"web_fetch", enabled:false },
          { name:"web_search", enabled:false },
        ],
      }],
    });
  });

  it("preserves CMA string input only for the exact deployment default", () => {
    expect(modelInputForSelection({ provider:"anthropic", id:"claude-sonnet-5", default:true }))
      .toBe("claude-sonnet-5");
    expect(modelInputForSelection({ provider:"openai", id:"gpt-5", default:false }))
      .toEqual({ provider:"openai", id:"gpt-5" });
    expect(modelInputForSelection({ provider:"openai", id:"gpt-5", default:true }))
      .toEqual({ provider:"openai", id:"gpt-5" });
    expect(() => modelInputForSelection(null)).toThrow("must be selected");
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

  it("reads every model-catalog page with workspace auth and no has_more assumption", async () => {
    setWorkspaceKey("oma_workspace");
    const fetchMock = vi.fn((url) => Promise.resolve({
      ok:true,
      status:200,
      text:() => Promise.resolve(JSON.stringify(url.includes("page=next")
        ? { data:[{ provider:"openai", id:"gpt-5" }], next_page:null }
        : { data:[{ provider:"anthropic", id:"claude-sonnet-5" }], next_page:"next" })),
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { origin: "http://oma.local" } });

    await expect(listModelCatalog()).resolves.toEqual({
      data:[
        { provider:"anthropic", id:"claude-sonnet-5" },
        { provider:"openai", id:"gpt-5" },
      ],
      truncated:false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      "x-api-key":"oma_workspace",
      "anthropic-beta":expect.stringContaining("managed-agents-2026-04-01"),
    });
  });

  it("reads and normalizes networking presets for the environment modal", async () => {
    setWorkspaceKey("oma_workspace");
    const fetchMock = vi.fn(() => Promise.resolve({
      ok:true,
      status:200,
      text:() => Promise.resolve(JSON.stringify({
        type:"environment_networking_presets",
        deployment:{ provider:"docker-local", egress_supported:true, reason:null },
        presets:[
          { id:"offline-v1", version:1, name:"Offline", description:"No network access.", networking:{ type:"limited", allowed_hosts:[] } },
          { id:"npm-pypi-v1", version:1, name:"npm + PyPI", description:"Package registries.", networking:{ type:"limited", allowed_hosts:["registry.npmjs.org", "pypi.org"] } },
        ],
        custom:{ https_only:true, wildcard_matches_bare_domain:false },
      })),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listEnvironmentNetworkingPresets()).resolves.toEqual({
      deployment:{ provider:"docker-local", egress_supported:true, reason:null },
      presets:[
        {
          id:"offline-v1",
          version:1,
          label:"Offline",
          description:"No network access.",
          allowed_hosts:[],
          config:{ networking:{ type:"limited", allowed_hosts:[] } },
        },
        {
          id:"npm-pypi-v1",
          version:1,
          label:"npm + PyPI",
          description:"Package registries.",
          allowed_hosts:["registry.npmjs.org", "pypi.org"],
          config:{ networking:{ type:"limited", allowed_hosts:["registry.npmjs.org", "pypi.org"] } },
        },
      ],
      custom:{ https_only:true, wildcard_matches_bare_domain:false },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/environments/networking-presets",
      expect.objectContaining({
        method:"GET",
        headers:expect.objectContaining({
          "x-api-key":"oma_workspace",
          "anthropic-beta":expect.stringContaining("managed-agents-2026-04-01"),
        }),
      }),
    );
  });

  it("loads networking presets with the rest of the console data", async () => {
    const page = (data) => JSON.stringify({ data, has_more:false, next_page:null });
    const fetchMock = vi.fn((url) => Promise.resolve({
      ok:true,
      status:200,
      text:() => Promise.resolve(
        url.startsWith("/v1/environments/networking-presets") ? JSON.stringify({
          deployment:{ provider:"docker-local", egress_supported:true, reason:null },
          presets:[{ id:"offline-v1", version:1, name:"Offline", description:"No network access.", networking:{ type:"limited", allowed_hosts:[] } }],
          custom:{ https_only:true, wildcard_matches_bare_domain:false },
        }) :
        url.startsWith("/v1/model-catalog") ? page([{ provider:"anthropic", id:"claude-sonnet-5" }]) :
        url.startsWith("/v1/files") ? JSON.stringify({ data:[], has_more:false, last_id:null }) :
        page([]),
      ),
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { origin: "http://oma.local" } });

    await expect(loadConsoleData()).resolves.toMatchObject({
      agents:[],
      sessions:[],
      environments:[],
      files:[],
      models:[{ provider:"anthropic", id:"claude-sonnet-5" }],
      networkingCatalog:{
        deployment:{ provider:"docker-local", egress_supported:true, reason:null },
        presets:[{
          id:"offline-v1",
          version:1,
          label:"Offline",
          description:"No network access.",
          allowed_hosts:[],
          config:{ networking:{ type:"limited", allowed_hosts:[] } },
        }],
        custom:{ https_only:true, wildcard_matches_bare_domain:false },
      },
    });
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
