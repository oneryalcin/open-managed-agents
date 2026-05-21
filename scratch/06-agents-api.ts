/**
 * Probe 06 — first HTTP agents API slice
 *
 * Starts a real Hono Node server, creates an agent, retrieves it, lists it,
 * and verifies the public ApiError envelope for a missing ID.
 *
 * Run: npx tsx scratch/06-agents-api.ts
 */

import { serve } from "@hono/node-server";
import { createInMemoryControlPlaneApp } from "../src/control-plane/app.ts";

const app = createInMemoryControlPlaneApp();
const server = serve({
  fetch: app.fetch,
  port: 0,
});

try {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const createRes = await fetch(`${baseUrl}/v1/agents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-beta": "managed-agents-2026-04-01",
    },
    body: JSON.stringify({
      name: "Probe Agent",
      model: { id: "claude-opus-4-7", speed: "fast" },
      system: "You are a probe agent.",
      tools: [{ type: "agent_toolset_20260401" }],
      metadata: { probe: "06" },
    }),
  });
  assertStatus(createRes, 200, "create agent");
  const created = (await createRes.json()) as { id?: unknown; name?: unknown };
  if (typeof created.id !== "string" || !created.id.startsWith("agent_")) {
    throw new Error(`create returned invalid id: ${JSON.stringify(created)}`);
  }
  console.log(`created: ${created.id}`);

  const retrieveRes = await fetch(`${baseUrl}/v1/agents/${created.id}`);
  assertStatus(retrieveRes, 200, "retrieve agent");
  const retrieved = (await retrieveRes.json()) as { id?: unknown; name?: unknown };
  if (retrieved.id !== created.id || retrieved.name !== "Probe Agent") {
    throw new Error(`retrieve mismatch: ${JSON.stringify(retrieved)}`);
  }
  console.log("retrieved: ok");

  const listRes = await fetch(`${baseUrl}/v1/agents?limit=10`);
  assertStatus(listRes, 200, "list agents");
  const listed = (await listRes.json()) as {
    data?: Array<{ id?: unknown }>;
    has_more?: unknown;
    next_page?: unknown;
  };
  if (
    listed.data?.length !== 1 ||
    listed.data[0]?.id !== created.id ||
    listed.has_more !== false ||
    listed.next_page !== null
  ) {
    throw new Error(`list mismatch: ${JSON.stringify(listed)}`);
  }
  console.log("listed: ok");

  const missingRes = await fetch(`${baseUrl}/v1/agents/agent_missing`);
  assertStatus(missingRes, 404, "missing agent");
  const missing = (await missingRes.json()) as {
    type?: unknown;
    error?: { type?: unknown; message?: unknown };
    request_id?: unknown;
  };
  if (
    missing.type !== "error" ||
    missing.error?.type !== "not_found_error" ||
    typeof missing.request_id !== "string" ||
    !missing.request_id.startsWith("req_")
  ) {
    throw new Error(`missing envelope mismatch: ${JSON.stringify(missing)}`);
  }
  console.log("missing error envelope: ok");

  console.log("=== done ===");
} finally {
  server.close();
}

function assertStatus(res: Response, expected: number, label: string): void {
  if (res.status !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${res.status}`);
  }
}
