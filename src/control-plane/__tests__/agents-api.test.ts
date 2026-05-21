import { describe, expect, it } from "vitest";
import { createInMemoryControlPlaneApp } from "../app.ts";
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

    const createdRes = await app.request("/v1/agents", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "managed-agents-2026-04-01",
      },
      body: JSON.stringify(VALID_AGENT),
    });
    expect(createdRes.status).toBe(200);
    const created = (await createdRes.json()) as ManagedAgentsAgent;
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
    const res = await app.request("/v1/agents?page=&limit=10");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
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
