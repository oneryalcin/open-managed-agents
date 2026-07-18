import { describe, expect, it } from "vitest";
import { createInMemoryControlPlaneApp } from "./helpers.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ApiErrorBody } from "../errors.ts";

const DISABLED_UNSUPPORTED_BUILTINS = ["web_fetch", "web_search"]
  .map((name) => ({ name, enabled: false }));

const VALID_AGENT = {
  name: "Coding Assistant",
  model: "claude-opus-4-7",
  system: "You are a helpful coding agent.",
  tools: [
    {
      type: "agent_toolset_20260401",
      default_config: { permission_policy: "always_ask" },
      configs: DISABLED_UNSUPPORTED_BUILTINS,
    },
  ],
};

describe("agents API", () => {
  it("creates, retrieves, and lists agents", async () => {
    const app = createInMemoryControlPlaneApp();

    const created = await createAgent(app, {
      "anthropic-beta": "managed-agents-2026-04-01",
    });
    expect(created).toMatchObject({
      id: expect.stringMatching(/^agent_/),
      type: "agent",
      name: "Coding Assistant",
      model: {
        provider: "anthropic",
        id: "claude-opus-4-7",
        speed: "standard",
      },
      version: 1,
      archived_at: null,
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: { permission_policy: { type: "always_ask" } },
          configs: DISABLED_UNSUPPORTED_BUILTINS,
        },
      ],
    });
    expect(created).not.toHaveProperty("workspace_id");

    const retrievedRes = await app.request(`/v1/agents/${created.id}`);
    expect(retrievedRes.status).toBe(200);
    await expect(retrievedRes.json()).resolves.toEqual(created);

    const listRes = await app.request("/v1/agents?limit=10");
    expect(listRes.status).toBe(200);
    await expect(listRes.json()).resolves.toEqual({
      data: [created],
      has_more: false,
      next_page: null,
    });
  });

  it("updates agents with immutable versions and optimistic concurrency", async () => {
    const app = createInMemoryControlPlaneApp();
    const created = await createAgent(app, {}, {
      ...VALID_AGENT,
      metadata: { stable: "one", remove_me: "yes" },
    });

    const updateRes = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        name: "Updated Agent",
        system: null,
        metadata: { stable: "two", remove_me: null },
      }),
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as ManagedAgentsAgent;
    expect(updated).toMatchObject({
      id: created.id,
      version: 2,
      name: "Updated Agent",
      system: null,
      metadata: { stable: "two" },
    });

    const stale = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, description: "stale" }),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Concurrent modification detected. Please fetch the latest version and retry.",
      },
    });

    const noOp = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 2 }),
    });
    expect(noOp.status).toBe(200);
    await expect(noOp.json()).resolves.toEqual(updated);

    const validAfterStale = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 2, description: "version three" }),
    });
    expect(validAfterStale.status).toBe(200);
    await expect(validAfterStale.json()).resolves.toMatchObject({ version: 3 });

    const historical = await app.request(`/v1/agents/${created.id}?version=1`);
    expect(historical.status).toBe(200);
    await expect(historical.json()).resolves.toEqual(created);

    const firstVersions = await app.request(`/v1/agents/${created.id}/versions?limit=1`);
    expect(firstVersions.status).toBe(200);
    const firstPage = (await firstVersions.json()) as {
      data: ManagedAgentsAgent[];
      next_page: string | null;
    };
    expect(firstPage.data.map((agent) => agent.version)).toEqual([3]);
    expect(firstPage.next_page).toEqual(expect.any(String));
    const secondVersions = await app.request(
      `/v1/agents/${created.id}/versions?limit=1&page=${firstPage.next_page}`,
    );
    const secondPage = (await secondVersions.json()) as {
      data: ManagedAgentsAgent[];
      next_page: string | null;
    };
    expect(secondPage.data.map((agent) => agent.version)).toEqual([2]);
    expect(secondPage.next_page).toEqual(expect.any(String));
  });

  it("persists explicit provider identity across updates and history", async () => {
    const app = createInMemoryControlPlaneApp();
    const created = await createAgent(app, {}, {
      ...VALID_AGENT,
      model: { provider: "openai", id: "gpt-5.4", speed: "fast" },
    });
    expect(created.model).toEqual({
      provider: "openai",
      id: "gpt-5.4",
      speed: "fast",
    });

    const updatedRes = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        model: { provider: "anthropic", id: "claude-opus-4-7" },
      }),
    });
    expect(updatedRes.status).toBe(200);
    await expect(updatedRes.json()).resolves.toMatchObject({
      version: 2,
      model: {
        provider: "anthropic",
        id: "claude-opus-4-7",
        speed: "standard",
      },
    });

    const historical = await app.request(`/v1/agents/${created.id}?version=1`);
    await expect(historical.json()).resolves.toMatchObject({
      version: 1,
      model: { provider: "openai", id: "gpt-5.4", speed: "fast" },
    });
  });

  it("archives agents idempotently and keeps direct retrieve available", async () => {
    const app = createInMemoryControlPlaneApp();
    const created = await createAgent(app);

    const archiveRes = await app.request(`/v1/agents/${created.id}/archive`, {
      method: "POST",
    });
    expect(archiveRes.status).toBe(200);
    const archived = (await archiveRes.json()) as ManagedAgentsAgent;
    expect(archived).toMatchObject({
      id: created.id,
      type: "agent",
      archived_at: expect.any(String),
    });

    const archiveAgainRes = await app.request(`/v1/agents/${created.id}/archive`, {
      method: "POST",
    });
    expect(archiveAgainRes.status).toBe(200);
    const archivedAgain = (await archiveAgainRes.json()) as ManagedAgentsAgent;
    expect(archivedAgain.archived_at).toBe(archived.archived_at);
    expect(archivedAgain.updated_at).toBe(archived.updated_at);

    const retrieveRes = await app.request(`/v1/agents/${created.id}`);
    expect(retrieveRes.status).toBe(200);
    await expect(retrieveRes.json()).resolves.toEqual(archived);
    const historicalRes = await app.request(`/v1/agents/${created.id}?version=1`);
    await expect(historicalRes.json()).resolves.toMatchObject({
      id: created.id,
      version: 1,
      archived_at: archived.archived_at,
    });
    const updateArchived = await app.request(`/v1/agents/${created.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, description: "blocked" }),
    });
    expect(updateArchived.status).toBe(400);
    await expect(updateArchived.json()).resolves.toMatchObject({
      error: { message: "Cannot modify archived agent" },
    });

    const defaultListRes = await app.request("/v1/agents?limit=10");
    expect(defaultListRes.status).toBe(200);
    await expect(defaultListRes.json()).resolves.toMatchObject({
      data: [],
      has_more: false,
      next_page: null,
    });

    const archivedListRes = await app.request(
      "/v1/agents?include_archived=true&limit=10",
    );
    expect(archivedListRes.status).toBe(200);
    await expect(archivedListRes.json()).resolves.toEqual({
      data: [archived],
      has_more: false,
      next_page: null,
    });
  });

  it("returns the public notFound envelope for missing archive targets", async () => {
    const app = createInMemoryControlPlaneApp();

    const res = await app.request("/v1/agents/agent_missing/archive", {
      method: "POST",
    });

    expect(res.status).toBe(404);
    const requestId = res.headers.get("request-id");
    expect(requestId).toEqual(expect.stringMatching(/^req_/));
    const body = (await res.json()) as ApiErrorBody;
    expect(body).toEqual({
      type: "error",
      error: {
        type: "not_found_error",
        message: "Agent agent_missing not found",
      },
      request_id: expect.stringMatching(/^req_/),
    });
    expect(body.request_id).toBe(requestId);
  });

  it("returns the Anthropic-shaped error envelope", async () => {
    const app = createInMemoryControlPlaneApp();

    const res = await app.request("/v1/agents/agent_missing");

    expect(res.status).toBe(404);
    const requestId = res.headers.get("request-id");
    expect(requestId).toEqual(expect.stringMatching(/^req_/));
    const body = (await res.json()) as ApiErrorBody;
    expect(body).toEqual({
      type: "error",
      error: {
        type: "not_found_error",
        message: "Agent agent_missing not found",
      },
      request_id: expect.stringMatching(/^req_/),
    });
    expect(body.request_id).toBe(requestId);
  });

  it("rejects invalid create payloads without leaking developer details", async () => {
    const app = createInMemoryControlPlaneApp();

    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4-7" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErrorBody;
    const requestId = res.headers.get("request-id");
    expect(requestId).toEqual(expect.stringMatching(/^req_/));
    expect(body).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "`name` must be a non-empty string",
      },
      request_id: expect.stringMatching(/^req_/),
    });
    expect(body.request_id).toBe(requestId);
    expect(JSON.stringify(body)).not.toContain("developerMessage");
  });

  it("rejects duplicate builtin agent toolsets", async () => {
    const app = createInMemoryControlPlaneApp();

    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...VALID_AGENT,
        tools: [
          {
            type: "agent_toolset_20260401",
            default_config: { enabled: false, permission_policy: { type: "always_allow" } },
          },
          {
            type: "agent_toolset_20260401",
            default_config: { enabled: false, permission_policy: { type: "always_ask" } },
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "`tools` may contain at most one `agent_toolset_20260401` entry",
      },
    });
  });

  it("rejects every non-null multiagent configuration before persistence", async () => {
    const app = createInMemoryControlPlaneApp();
    const values = [
      {
        type: "coordinator",
        agents: [{ type: "agent", id: "agent_child" }],
      },
      {},
      "not-an-object",
      0,
    ];
    for (const [index, multiagent] of values.entries()) {
      const res = await app.request("/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `Unsupported multiagent ${index}`,
          model: "claude-opus-4-7",
          multiagent,
        }),
      });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: {
          type: "invalid_request_error",
          message: "The `multiagent` configuration is not supported by this deployment.",
        },
      });
    }
    const listed = await app.request("/v1/agents?limit=10");
    await expect(listed.json()).resolves.toMatchObject({ data: [] });
  });

  it("preserves an explicit null multiagent value", async () => {
    const app = createInMemoryControlPlaneApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Null multiagent",
        model: "claude-opus-4-7",
        multiagent: null,
      }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ multiagent: null });
  });

  it("materializes deployment defaults for unsupported builtin tools", async () => {
    const app = createInMemoryControlPlaneApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Implicit Defaults",
        model: "claude-opus-4-7",
        tools: [{ type: "agent_toolset_20260401" }],
      }),
    });
    expect(res.status).toBe(200);
    const agent = (await res.json()) as ManagedAgentsAgent;
    expect(agent.tools).toEqual([{
      type: "agent_toolset_20260401",
      default_config: {
        enabled: true,
        permission_policy: { type: "always_allow" },
      },
      configs: DISABLED_UNSUPPORTED_BUILTINS,
    }]);
  });

  it("rejects unknown builtin names, policies, and duplicate configs before persistence", async () => {
    const app = createInMemoryControlPlaneApp();
    const cases = [
      {
        name: "unknown name",
        configs: [{ name: "find" }],
        message: "not a valid value",
      },
      {
        name: "unknown policy",
        configs: [{ name: "bash", permission_policy: { type: "never_allow" } }],
        message: "permission_policy.type",
      },
      {
        name: "duplicate config",
        configs: [{ name: "bash" }, { name: "bash" }],
        message: "duplicate builtin tool config",
      },
    ];
    for (const item of cases) {
      const res = await app.request("/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `Invalid ${item.name}`,
          model: "claude-opus-4-7",
          tools: [{ type: "agent_toolset_20260401", configs: item.configs }],
        }),
      });
      expect(res.status, item.name).toBe(400);
      await expect(res.text()).resolves.toContain(item.message);
    }
    const listed = await app.request("/v1/agents?limit=10");
    await expect(listed.json()).resolves.toMatchObject({ data: [] });
  });

  it("matches probe 63 precedence for mixed-invalid builtin configs", async () => {
    const app = createInMemoryControlPlaneApp();
    const cases = [
      {
        name: "unknown config name wins over malformed default policy",
        configs: [{ name: "oma_probe_unknown_tool" }],
        default_config: { permission_policy: { type: 42 } },
        message: "`configs[].name`",
      },
      {
        name: "unknown default policy wins over unknown config name",
        configs: [{ name: "oma_probe_unknown_tool" }],
        default_config: { permission_policy: { type: "oma_probe_unknown_policy" } },
        message: "`permission_policy.type`",
      },
      {
        name: "unknown default policy wins over malformed config name",
        configs: [{ name: 42 }],
        default_config: { permission_policy: { type: "oma_probe_unknown_policy" } },
        message: "`permission_policy.type`",
      },
      {
        name: "unknown per-config policy wins over unknown config name",
        configs: [{ name: "oma_probe_unknown_tool", permission_policy: { type: "oma_probe_unknown_policy" } }],
        default_config: undefined,
        message: "`permission_policy.type`",
      },
    ];

    for (const item of cases) {
      const res = await app.request("/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `Mixed invalid ${item.name}`,
          model: "claude-opus-4-7",
          tools: [{
            type: "agent_toolset_20260401",
            configs: item.configs,
            ...(item.default_config === undefined
              ? {}
              : { default_config: item.default_config }),
          }],
        }),
      });
      expect(res.status, item.name).toBe(400);
      await expect(res.text(), item.name).resolves.toContain(item.message);
    }
  });

  it("accepts executable builtin names and both hosted policies", async () => {
    const app = createInMemoryControlPlaneApp();
    const names = ["bash", "edit", "glob", "grep", "read", "write"];
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Hosted Vocabulary",
        model: "claude-opus-4-7",
        tools: [{
          type: "agent_toolset_20260401",
          default_config: {
            enabled: false,
            permission_policy: { type: "always_ask" },
          },
          configs: names.map((name, index) => ({
            name,
            enabled: true,
            permission_policy: { type: index % 2 === 0 ? "always_allow" : "always_ask" },
          })),
        }],
      }),
    });
    expect(res.status).toBe(200);
    const agent = (await res.json()) as ManagedAgentsAgent;
    expect((agent.tools[0] as { configs: unknown[] }).configs).toHaveLength(
      names.length + DISABLED_UNSUPPORTED_BUILTINS.length,
    );
  });

  it("validates effective enablement for unsupported builtins", async () => {
    const app = createInMemoryControlPlaneApp();
    for (const name of ["web_fetch", "web_search"]) {
      const res = await app.request("/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `Unsupported ${name}`,
          model: "claude-opus-4-7",
          tools: [{
            type: "agent_toolset_20260401",
            default_config: { enabled: false },
            configs: [{ name, enabled: true }],
          }],
        }),
      });
      expect(res.status).toBe(400);
      await expect(res.text()).resolves.toContain(
        `Builtin tool \`${name}\` is not supported by this deployment yet`,
      );
    }

    const inheritedEnabled = await app.request("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Inherited enabled unsupported tool",
        model: "claude-opus-4-7",
        tools: [{
          type: "agent_toolset_20260401",
          default_config: { enabled: true },
          configs: [{ name: "web_fetch" }],
        }],
      }),
    });
    expect(inheritedEnabled.status).toBe(400);

    const afterRejected = await app.request("/v1/agents?limit=10");
    await expect(afterRejected.json()).resolves.toMatchObject({ data: [] });

    const inheritedDisabled = await app.request("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Inherited disabled unsupported tool",
        model: "claude-opus-4-7",
        tools: [{
          type: "agent_toolset_20260401",
          default_config: { enabled: false },
          configs: [{ name: "web_fetch" }],
        }],
      }),
    });
    expect(inheritedDisabled.status).toBe(200);

    const explicitlyDisabled = await app.request("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Explicitly disabled unsupported tools",
        model: "claude-opus-4-7",
        tools: [{
          type: "agent_toolset_20260401",
          configs: DISABLED_UNSUPPORTED_BUILTINS,
        }],
      }),
    });
    expect(explicitlyDisabled.status).toBe(200);
  });

  it("returns the public notFound envelope for unregistered routes", async () => {
    const app = createInMemoryControlPlaneApp();

    const res = await app.request("/v1/unknown");

    expect(res.status).toBe(404);
    const requestId = res.headers.get("request-id");
    const body = (await res.json()) as ApiErrorBody;
    expect(body).toEqual({
      type: "error",
      error: {
        type: "not_found_error",
        message: "Route not found",
      },
      request_id: expect.stringMatching(/^req_/),
    });
    expect(body.request_id).toBe(requestId);
  });

  it("treats an empty page cursor as omitted", async () => {
    const app = createInMemoryControlPlaneApp();

    await app.request("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID_AGENT),
    });
    const omittedRes = await app.request("/v1/agents?limit=10");
    const emptyRes = await app.request("/v1/agents?page=&limit=10");

    expect(emptyRes.status).toBe(200);
    await expect(emptyRes.json()).resolves.toEqual(await omittedRes.json());
  });

  it("rejects non-finite numbers in JSON-compatible schemas", async () => {
    const app = createInMemoryControlPlaneApp();

    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{
        "name": "Bad Schema",
        "model": "claude-opus-4-7",
        "tools": [
          {
            "type": "custom",
            "name": "bad",
            "input_schema": { "maximum": 1e999 }
          }
        ]
      }`,
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error).toEqual({
      type: "invalid_request_error",
      message: "`tools` entries must be JSON-compatible",
    });
  });
});

async function createAgent(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
  headers: Record<string, string> = {},
  input: Record<string, unknown> = VALID_AGENT,
): Promise<ManagedAgentsAgent> {
  const res = await app.request("/v1/agents", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(input),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsAgent;
}
