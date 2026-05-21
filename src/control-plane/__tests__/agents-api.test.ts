import { describe, expect, it } from "vitest";
import { createInMemoryControlPlaneApp } from "../app.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";

const VALID_AGENT = {
  name: "Coding Assistant",
  model: "claude-opus-4-7",
  system: "You are a helpful coding agent.",
  tools: [{ type: "agent_toolset_20260401" }],
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
    await expect(res.json()).resolves.toEqual({
      type: "error",
      error: {
        type: "not_found_error",
        message: "Agent agent_missing not found",
      },
      request_id: expect.stringMatching(/^req_/),
    });
  });

  it("rejects invalid create payloads without leaking developer details", async () => {
    const app = createInMemoryControlPlaneApp();

    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4-7" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "`name` must be a non-empty string",
      },
    });
    expect(JSON.stringify(body)).not.toContain("developerMessage");
  });
});
