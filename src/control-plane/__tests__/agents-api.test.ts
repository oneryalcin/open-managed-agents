import { describe, expect, it } from "vitest";
import { createInMemoryControlPlaneApp } from "./helpers.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ApiErrorBody } from "../errors.ts";

const VALID_AGENT = {
  name: "Coding Assistant",
  model: "claude-opus-4-7",
  system: "You are a helpful coding agent.",
  tools: [
    {
      type: "agent_toolset_20260401",
      default_config: { permission_policy: "always_ask" },
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
      model: { id: "claude-opus-4-7", speed: "standard" },
      version: 1,
      archived_at: null,
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: { permission_policy: { type: "always_ask" } },
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
            default_config: { permission_policy: { type: "always_allow" } },
          },
          {
            type: "agent_toolset_20260401",
            default_config: { permission_policy: { type: "always_ask" } },
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

  it("materializes the hosted default builtin tool config when omitted", async () => {
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
      configs: [],
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

  it("accepts the hosted builtin vocabulary and both hosted policies", async () => {
    const app = createInMemoryControlPlaneApp();
    const names = ["bash", "edit", "glob", "grep", "read", "web_fetch", "web_search", "write"];
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Hosted Vocabulary",
        model: "claude-opus-4-7",
        tools: [{
          type: "agent_toolset_20260401",
          default_config: { permission_policy: { type: "always_ask" } },
          configs: names.map((name, index) => ({
            name,
            permission_policy: { type: index % 2 === 0 ? "always_allow" : "always_ask" },
          })),
        }],
      }),
    });
    expect(res.status).toBe(200);
    const agent = (await res.json()) as ManagedAgentsAgent;
    expect((agent.tools[0] as { configs: unknown[] }).configs).toHaveLength(names.length);
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
): Promise<ManagedAgentsAgent> {
  const res = await app.request("/v1/agents", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(VALID_AGENT),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsAgent;
}
