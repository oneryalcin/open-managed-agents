import { describe, expect, it } from "vitest";
import {
  MAX_REQUEST_BODY_BYTES,
  MANAGED_AGENTS_BETA,
  createInMemoryControlPlaneApp,
  parseBetaFeatures,
} from "../app.ts";
import type { ApiErrorBody } from "../errors.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";

const VALID_AGENT = {
  name: "B1 Agent",
  model: "claude-opus-4-7",
  tools: [{ type: "agent_toolset_20260401" }],
};

const VALID_ENVIRONMENT = {
  name: "Cloud Environment",
  config: {
    type: "cloud",
    networking: { type: "unrestricted" },
  },
};

describe("Cycle B.1 API", () => {
  it("parses managed-agents beta headers without rejecting future betas", () => {
    expect(parseBetaFeatures(undefined)).toEqual(new Set());
    expect(parseBetaFeatures(MANAGED_AGENTS_BETA)).toEqual(
      new Set([MANAGED_AGENTS_BETA]),
    );
    expect(parseBetaFeatures(`${MANAGED_AGENTS_BETA}, future-beta`)).toEqual(
      new Set([MANAGED_AGENTS_BETA, "future-beta"]),
    );
  });

  it("creates, retrieves, and lists environments with opaque config roundtrip", async () => {
    const app = createInMemoryControlPlaneApp();

    const created = await createEnvironment(app);
    expect(created).toMatchObject({
      id: expect.stringMatching(/^env_/),
      type: "environment",
      name: "Cloud Environment",
      config: VALID_ENVIRONMENT.config,
      archived_at: null,
    });
    expect(created).not.toHaveProperty("workspace_id");

    const retrieveRes = await app.request(`/v1/environments/${created.id}`);
    expect(retrieveRes.status).toBe(200);
    await expect(retrieveRes.json()).resolves.toEqual(created);

    const listRes = await app.request("/v1/environments?limit=10");
    expect(listRes.status).toBe(200);
    await expect(listRes.json()).resolves.toEqual({
      data: [created],
      has_more: false,
      next_page: null,
    });
  });

  it("creates sessions from string and object agent refs and returns canonical agent refs", async () => {
    const app = createInMemoryControlPlaneApp();
    const agent = await createAgent(app);
    const environment = await createEnvironment(app);

    const fromString = await createSession(app, {
      agent: agent.id,
      environment_id: environment.id,
      title: "String agent ref",
      metadata: { source: "test" },
    });
    expect(fromString).toMatchObject({
      id: expect.stringMatching(/^sesn_/),
      type: "session",
      agent: { type: "agent", id: agent.id, version: 1 },
      environment_id: environment.id,
      status: "idle",
      title: "String agent ref",
      metadata: { source: "test" },
      archived_at: null,
      usage: null,
    });
    expect(fromString).not.toHaveProperty("workspace_id");

    const fromObject = await createSession(app, {
      agent: { type: "agent", id: agent.id, version: 1 },
      environment_id: environment.id,
    });
    expect(fromObject.agent).toEqual({ type: "agent", id: agent.id, version: 1 });

    const retrieveRes = await app.request(`/v1/sessions/${fromString.id}`);
    expect(retrieveRes.status).toBe(200);
    await expect(retrieveRes.json()).resolves.toEqual(fromString);
  });

  it("rejects requested agent versions that do not exist", async () => {
    const app = createInMemoryControlPlaneApp();
    const agent = await createAgent(app);
    const environment = await createEnvironment(app);

    await expectError(
      await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: { type: "agent", id: agent.id, version: 999 },
          environment_id: environment.id,
        }),
      }),
      400,
      "invalid_request_error",
      `Agent ${agent.id} has version 1; requested version 999 not found`,
    );
  });

  it("lists sessions with agent_id filter, order, page, and empty page handling", async () => {
    const app = createInMemoryControlPlaneApp();
    const agent = await createAgent(app);
    const otherAgent = await createAgent(app, { name: "Other Agent" });
    const environment = await createEnvironment(app);
    const first = await createSession(app, {
      agent: agent.id,
      environment_id: environment.id,
      title: "First",
    });
    const second = await createSession(app, {
      agent: agent.id,
      environment_id: environment.id,
      title: "Second",
    });
    await createSession(app, {
      agent: otherAgent.id,
      environment_id: environment.id,
      title: "Other",
    });

    const descRes = await app.request(
      `/v1/sessions?agent_id=${agent.id}&order=desc&limit=1`,
    );
    expect(descRes.status).toBe(200);
    const descPage = (await descRes.json()) as {
      data: ManagedAgentsSession[];
      has_more: boolean;
      next_page: string | null;
    };
    expect(descPage.data.map((s) => s.id)).toEqual([second.id]);
    expect(descPage.has_more).toBe(true);
    expect(descPage.next_page).toBe(second.id);

    const nextDescRes = await app.request(
      `/v1/sessions?agent_id=${agent.id}&order=desc&limit=1&page=${descPage.next_page}`,
    );
    expect(nextDescRes.status).toBe(200);
    const nextDescPage = (await nextDescRes.json()) as {
      data: ManagedAgentsSession[];
      has_more: boolean;
      next_page: string | null;
    };
    expect(nextDescPage.data.map((s) => s.id)).toEqual([first.id]);
    expect(nextDescPage.has_more).toBe(false);
    expect(nextDescPage.next_page).toBe(null);

    const omittedRes = await app.request(
      `/v1/sessions?agent_id=${agent.id}&limit=10`,
    );
    const emptyRes = await app.request(
      `/v1/sessions?agent_id=${agent.id}&page=&limit=10`,
    );
    expect(emptyRes.status).toBe(200);
    await expect(emptyRes.json()).resolves.toEqual(await omittedRes.json());

    const ascRes = await app.request(
      `/v1/sessions?agent_id=${agent.id}&order=asc&limit=1`,
    );
    expect(ascRes.status).toBe(200);
    const ascPage = (await ascRes.json()) as {
      data: ManagedAgentsSession[];
      has_more: boolean;
      next_page: string | null;
    };
    expect(ascPage.data.map((s) => s.id)).toEqual([first.id]);
    expect(ascPage.has_more).toBe(true);
    expect(ascPage.next_page).toBe(first.id);

    await expectError(
      await app.request(`/v1/sessions?agent_id=${agent.id}&order=sideways`),
      400,
      "invalid_request_error",
      "`order` must be `asc` or `desc`",
    );
  });

  it("uses invalid_request_error for missing referenced agent or environment", async () => {
    const app = createInMemoryControlPlaneApp();
    const agent = await createAgent(app);
    const environment = await createEnvironment(app);

    await expectError(
      await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "agent_missing",
          environment_id: environment.id,
        }),
      }),
      400,
      "invalid_request_error",
      "Agent agent_missing not found",
    );

    await expectError(
      await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: agent.id,
          environment_id: "env_missing",
        }),
      }),
      400,
      "invalid_request_error",
      "Environment env_missing not found",
    );
  });

  it("uses not_found_error for missing retrieved sessions and environments", async () => {
    const app = createInMemoryControlPlaneApp();

    await expectError(
      await app.request("/v1/sessions/sesn_missing"),
      404,
      "not_found_error",
      "Session sesn_missing not found",
    );
    await expectError(
      await app.request("/v1/environments/env_missing"),
      404,
      "not_found_error",
      "Environment env_missing not found",
    );
  });

  it("rejects unsupported runtime-bearing session fields explicitly", async () => {
    const app = createInMemoryControlPlaneApp();
    const agent = await createAgent(app);
    const environment = await createEnvironment(app);

    await expectError(
      await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: agent.id,
          environment_id: environment.id,
          sandbox_provider: {
            type: "host-passthrough",
            unsafeAllowHostPassthrough: true,
          },
        }),
      }),
      400,
      "invalid_request_error",
      "Field `sandbox_provider` is not yet supported by this server.",
    );

    await expectError(
      await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: agent.id,
          environment_id: environment.id,
          resources: [],
        }),
      }),
      400,
      "invalid_request_error",
      "Field `resources` is not yet supported by this server.",
    );

    await expectError(
      await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: agent.id,
          environment_id: environment.id,
          vault_ids: [],
        }),
      }),
      400,
      "invalid_request_error",
      "Field `vault_ids` is not yet supported by this server.",
    );
  });

  it("rejects unknown session-create fields instead of silently ignoring them", async () => {
    const app = createInMemoryControlPlaneApp();
    const agent = await createAgent(app);
    const environment = await createEnvironment(app);

    await expectError(
      await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: agent.id,
          environment_id: environment.id,
          future_runtime_field: { enabled: true },
        }),
      }),
      400,
      "invalid_request_error",
      "Unsupported session create field: `future_runtime_field`.",
    );
  });

  it("keeps sandbox provider selection out of public session create", async () => {
    const app = createInMemoryControlPlaneApp();
    const agent = await createAgent(app);
    const environment = await createEnvironment(app);

    await expectError(
      await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: agent.id,
          environment_id: environment.id,
          sandboxProviderSelection: {
            type: "host-passthrough",
            unsafeAllowHostPassthrough: true,
          },
        }),
      }),
      400,
      "invalid_request_error",
      "Field `sandboxProviderSelection` is not yet supported by this server.",
    );
  });

  it("rejects non-finite JSON values and non-string metadata values", async () => {
    const app = createInMemoryControlPlaneApp();
    const agent = await createAgent(app);
    const environment = await createEnvironment(app);

    await expectError(
      await app.request("/v1/environments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{
          "name": "Bad Environment",
          "config": { "maximum": 1e999 }
        }`,
      }),
      400,
      "invalid_request_error",
      "`config` must be JSON-compatible",
    );

    await expectError(
      await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{
          "agent": "${agent.id}",
          "environment_id": "${environment.id}",
          "metadata": { "attempts": 1e999 }
        }`,
      }),
      400,
      "invalid_request_error",
      "`metadata` values must be strings",
    );
  });

  it("returns the public request_too_large envelope for oversized bodies", async () => {
    const app = createInMemoryControlPlaneApp();

    await expectError(
      await app.request("/v1/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
        },
        body: "{}",
      }),
      413,
      "request_too_large",
      "Request body is too large",
    );
  });

  it("returns the public invalid_request_error envelope for malformed JSON", async () => {
    const app = createInMemoryControlPlaneApp();

    await expectError(
      await app.request("/v1/environments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      400,
      "invalid_request_error",
      "Request body must be valid JSON",
    );
  });
});

async function createAgent(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
  overrides: Partial<typeof VALID_AGENT> = {},
): Promise<ManagedAgentsAgent> {
  const res = await app.request("/v1/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...VALID_AGENT, ...overrides }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsAgent;
}

async function createEnvironment(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
): Promise<ManagedAgentsEnvironment> {
  const res = await app.request("/v1/environments", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-beta": `${MANAGED_AGENTS_BETA}, future-beta`,
    },
    body: JSON.stringify(VALID_ENVIRONMENT),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsEnvironment;
}

async function createSession(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
  body: unknown,
): Promise<ManagedAgentsSession> {
  const res = await app.request("/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsSession;
}

async function expectError(
  res: Response,
  status: number,
  type: ApiErrorBody["error"]["type"],
  message: string,
): Promise<void> {
  expect(res.status).toBe(status);
  const requestId = res.headers.get("request-id");
  expect(requestId).toEqual(expect.stringMatching(/^req_/));
  const body = (await res.json()) as ApiErrorBody;
  expect(body).toEqual({
    type: "error",
    error: { type, message },
    request_id: expect.stringMatching(/^req_/),
  });
  expect(body.request_id).toBe(requestId);
}
