/**
 * Probe 07 — Cycle B.1 environments + sessions HTTP slice
 *
 * Starts a real Hono Node server, creates an agent, creates an environment,
 * creates sessions through both accepted agent reference shapes, lists sessions,
 * and verifies unsupported runtime-bearing fields return the public ApiError
 * envelope.
 *
 * Run: npx tsx scratch/07-b1-api.ts
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

  const agent = await postJson<{ id: string }>(`${baseUrl}/v1/agents`, {
    name: "Probe B1 Agent",
    model: "claude-opus-4-7",
    tools: [{ type: "agent_toolset_20260401" }],
  });
  assertPrefix(agent.id, "agent_", "agent id");
  console.log(`agent: ${agent.id}`);

  const environment = await postJson<{ id: string; config: unknown }>(
    `${baseUrl}/v1/environments`,
    {
      name: "Probe Cloud",
      config: { type: "cloud", networking: { type: "unrestricted" } },
    },
  );
  assertPrefix(environment.id, "env_", "environment id");
  console.log(`environment: ${environment.id}`);

  const firstSession = await postJson<{
    id: string;
    agent: { type: string; id: string; version: number };
    environment_id: string;
    status: string;
  }>(`${baseUrl}/v1/sessions`, {
    agent: agent.id,
    environment_id: environment.id,
    title: "String agent ref",
    metadata: { probe: "07" },
  });
  assertPrefix(firstSession.id, "sesn_", "session id");
  assertEqual(firstSession.agent, {
    type: "agent",
    id: agent.id,
    version: 1,
  }, "canonical session agent ref");
  assertEqual(firstSession.environment_id, environment.id, "session environment");
  assertEqual(firstSession.status, "idle", "session status");
  console.log(`session string-ref: ${firstSession.id}`);

  const secondSession = await postJson<{
    id: string;
    agent: { type: string; id: string; version: number };
  }>(`${baseUrl}/v1/sessions`, {
    agent: { type: "agent", id: agent.id, version: 1 },
    environment_id: environment.id,
  });
  assertEqual(secondSession.agent.version, 1, "requested current version");
  console.log(`session object-ref: ${secondSession.id}`);

  const listRes = await fetch(
    `${baseUrl}/v1/sessions?agent_id=${agent.id}&order=desc&limit=10`,
  );
  assertStatus(listRes, 200, "list sessions");
  const listed = (await listRes.json()) as {
    data?: Array<{ id?: unknown }>;
    has_more?: unknown;
    next_page?: unknown;
  };
  assertEqual(
    listed.data?.map((session) => session.id),
    [secondSession.id, firstSession.id],
    "session list order",
  );
  assertEqual(listed.has_more, false, "session list has_more");
  assertEqual(listed.next_page, null, "session list next_page");
  console.log("sessions list: ok");

  const unsupportedRes = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent: agent.id,
      environment_id: environment.id,
      resources: [],
    }),
  });
  assertStatus(unsupportedRes, 400, "unsupported resources");
  const unsupported = (await unsupportedRes.json()) as {
    type?: unknown;
    error?: { type?: unknown; message?: unknown };
    request_id?: unknown;
  };
  assertEqual(unsupported.type, "error", "unsupported outer type");
  assertEqual(
    unsupported.error,
    {
      type: "invalid_request_error",
      message: "Field `resources` is not yet supported by this server.",
    },
    "unsupported error",
  );
  if (
    typeof unsupported.request_id !== "string" ||
    !unsupported.request_id.startsWith("req_")
  ) {
    throw new Error(`invalid request_id: ${JSON.stringify(unsupported)}`);
  }
  console.log("unsupported field envelope: ok");

  console.log("=== done ===");
} finally {
  server.close();
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-beta": "managed-agents-2026-04-01, future-beta",
    },
    body: JSON.stringify(body),
  });
  assertStatus(res, 200, `POST ${url}`);
  return (await res.json()) as T;
}

function assertStatus(res: Response, expected: number, label: string): void {
  if (res.status !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${res.status}`);
  }
}

function assertPrefix(value: unknown, prefix: string, label: string): void {
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    throw new Error(`${label}: expected ${prefix}..., got ${JSON.stringify(value)}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
