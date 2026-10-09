import { expect } from "vitest";
import type { createInMemoryControlPlaneApp } from "./helpers.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";

// Shared API steps for control-plane tests. Several older test files still
// carry their own copies of these; new tests should use this module.

type App = Pick<ReturnType<typeof createInMemoryControlPlaneApp>, "request">;

async function postJson<T>(app: App, path: string, body: unknown): Promise<T> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
}

/** An agent, a cloud environment and a session using them. */
export async function setupSession(app: App): Promise<ManagedAgentsSession> {
  const agent = await postJson<{ id: string }>(app, "/v1/agents", {
    name: "Test Agent",
    model: "claude-opus-4-7",
    tools: [{ type: "agent_toolset_20260401" }],
  });
  const environment = await postJson<{ id: string }>(app, "/v1/environments", {
    name: "Test Environment",
    config: { type: "cloud" },
  });
  return postJson<ManagedAgentsSession>(app, "/v1/sessions", {
    agent: agent.id,
    environment_id: environment.id,
  });
}

export async function sendMessage(app: App, sessionId: string, text: string): Promise<void> {
  await postJson(app, `/v1/sessions/${sessionId}/events`, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
}

export async function getSession(app: App, sessionId: string): Promise<ManagedAgentsSession> {
  const res = await app.request(`/v1/sessions/${sessionId}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsSession;
}

export async function listEvents(
  app: App,
  sessionId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await app.request(`/v1/sessions/${sessionId}/events?order=asc&limit=1000`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Array<Record<string, unknown>> }).data;
}

/** Polls until `predicate` holds; throws after ~2s instead of passing silently. */
export async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor: condition never held");
}

/** Waits until the session's latest turn has ended (idle, any stop reason). */
export async function waitForIdle(app: App, sessionId: string, idles = 1): Promise<void> {
  await waitFor(async () =>
    (await listEvents(app, sessionId)).filter((e) => e.type === "session.status_idle").length >= idles,
  );
}
