/**
 * Probe 17 — Cycle D multiple custom-tool wait behavior.
 *
 * Answers the remaining D parity question before aggregation work:
 * can real Pi enter multiple custom-tool waits before any external result is
 * supplied, or does it serialize custom tool execution?
 *
 * Run:
 *   ANTHROPIC_API_KEY=... npx tsx scratch/17-d-custom-tool-parallel.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createControlPlaneApp } from "../src/control-plane/app.ts";
import { requestWithManagedAgentsBeta } from "./managed-agents-beta.ts";
import { DefaultAgentService } from "../src/control-plane/agents/service.ts";
import { SqliteAgentStore } from "../src/control-plane/agents/store.ts";
import { DefaultEnvironmentService } from "../src/control-plane/environments/service.ts";
import { SqliteEnvironmentStore } from "../src/control-plane/environments/store.ts";
import { createBestEffortRuntimeEventCoordinator } from "../src/control-plane/deployment-runtime-event-coordinator.ts";
import { SessionEventBroadcaster } from "../src/control-plane/events/broadcaster.ts";
import { DefaultSessionEventsService } from "../src/control-plane/events/service.ts";
import { EventStore } from "../src/control-plane/events/store.ts";
import { DefaultSessionService } from "../src/control-plane/sessions/service.ts";
import { PiSessionRunner } from "../src/control-plane/sessions/pi/runner.ts";
import { translatePiEvent } from "../src/control-plane/sessions/pi/translator.ts";
import { SqliteSessionStore } from "../src/control-plane/sessions/store.ts";
import type { ManagedAgentsCustomTool } from "../src/types/agents.ts";

const TIMEOUT_MS = 120_000;
const PARALLEL_WAIT_MS = 5_000;
const OUT_DIR = join(process.cwd(), "scratch", "artifacts", "pi-custom-tools");

const TOOLS = [
  customTool("ask_alpha", "Ask external alpha."),
  customTool("ask_beta", "Ask external beta."),
];

const agentStore = SqliteAgentStore.open(":memory:");
const environmentStore = SqliteEnvironmentStore.open(":memory:");
const sessionStore = SqliteSessionStore.open(":memory:");
const eventStore = EventStore.open(":memory:");
const broadcaster = new SessionEventBroadcaster(eventStore);
const runner = new PiSessionRunner({
  customTools: () => TOOLS,
});
const app = createControlPlaneApp({
  agents: new DefaultAgentService(agentStore, undefined),
  environments: new DefaultEnvironmentService(environmentStore),
  sessions: new DefaultSessionService(sessionStore, agentStore, environmentStore, undefined, { assertDeletable: () => {} }),
  sessionEvents: new DefaultSessionEventsService(eventStore, sessionStore, broadcaster, {
    runner,
    translate: translatePiEvent,
    runtimeEventCoordinator: createBestEffortRuntimeEventCoordinator({
      sessions: sessionStore,
      events: eventStore,
    }),
  }),
});

const agent = (await create("/v1/agents", {
  name: "Probe Agent D Parallel Custom Tools",
  model: "claude-haiku-4-5",
  tools: TOOLS,
})) as { id: string };
const environment = (await create("/v1/environments", {
  name: "Probe Environment D Parallel Custom Tools",
  config: { type: "cloud", networking: { type: "unrestricted" } },
})) as { id: string };
const session = (await create("/v1/sessions", {
  agent: agent.id,
  environment_id: environment.id,
})) as { id: string };

console.log(`session=${session.id}`);

await sendMessage(
  session.id,
  [
    "You have exactly two available custom tools: ask_alpha and ask_beta.",
    "Call ask_alpha with question='alpha' and ask_beta with question='beta'.",
    "Do not answer until both tool results are available.",
    "After both results return, reply with exactly: BOTH_RESULTS_OK",
  ].join(" "),
);

const firstRequiresAction = await eventuallyEvents(
  session.id,
  (events) => events.some(isRequiresAction),
  "first requires_action",
);
await sleep(PARALLEL_WAIT_MS);
const beforeAnyResult = await getEvents(`/v1/sessions/${session.id}/events?order=asc`);
const firstWindow = beforeAnyResult.data;
const firstWindowCustomUses = firstWindow.filter(
  (event) => event.type === "agent.custom_tool_use",
);
const firstWindowRequiresActions = firstWindow.filter(isRequiresAction);
const enteredParallelWait = firstWindowCustomUses.length > 1;

for (const customUse of firstWindowCustomUses) {
  await sendCustomToolResult(
    session.id,
    customUse.id as string,
    `${String(customUse.name)} result`,
  );
}

let afterFirstResults = await eventuallyEvents(
  session.id,
  (events) =>
    hasEndTurn(events) ||
    events.filter((event) => event.type === "agent.custom_tool_use").length >
      firstWindowCustomUses.length,
  "second custom use or final idle",
);
let laterCustomUses = afterFirstResults.filter(
  (event) => event.type === "agent.custom_tool_use",
).slice(firstWindowCustomUses.length);

for (const customUse of laterCustomUses) {
  await sendCustomToolResult(
    session.id,
    customUse.id as string,
    `${String(customUse.name)} result`,
  );
}

const finalEvents = await eventuallyEvents(
  session.id,
  hasEndTurn,
  "final end_turn idle",
);
afterFirstResults = finalEvents;
laterCustomUses = afterFirstResults
  .filter((event) => event.type === "agent.custom_tool_use")
  .slice(firstWindowCustomUses.length);

runner.close();
mkdirSync(OUT_DIR, { recursive: true });

const allCustomUses = finalEvents.filter(
  (event) => event.type === "agent.custom_tool_use",
);
const allRequiresActions = finalEvents.filter(isRequiresAction);
const summary = {
  generated_at: new Date().toISOString(),
  session_id: session.id,
  first_requires_action_event_count: firstRequiresAction.length,
  first_window_custom_tool_count: firstWindowCustomUses.length,
  first_window_requires_action_count: firstWindowRequiresActions.length,
  entered_parallel_wait: enteredParallelWait,
  later_custom_tool_count: laterCustomUses.length,
  custom_tool_names: allCustomUses.map((event) => event.name),
  requires_action_event_ids: allRequiresActions.map(
    (event) => (event.stop_reason as { event_ids?: unknown }).event_ids,
  ),
  final_event_types: finalEvents.map((event) => event.type),
  verdict: allCustomUses.length >= 1 ? "PASS" : "FAIL",
};
writeFileSync(
  join(OUT_DIR, "_d-live-custom-tool-parallel-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));

function customTool(name: string, description: string): ManagedAgentsCustomTool {
  return {
    type: "custom",
    name,
    description,
    input_schema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  };
}

function isRequiresAction(event: Record<string, unknown>): boolean {
  return (
    event.type === "session.status_idle" &&
    (event.stop_reason as { type?: unknown } | undefined)?.type ===
      "requires_action"
  );
}

function hasEndTurn(events: Array<Record<string, unknown>>): boolean {
  return events.some(
    (event) =>
      event.type === "session.status_idle" &&
      (event.stop_reason as { type?: unknown } | undefined)?.type === "end_turn",
  );
}

async function create(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await requestWithManagedAgentsBeta(app, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    throw new Error(`create ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

async function sendMessage(sessionId: string, text: string): Promise<void> {
  const res = await requestWithManagedAgentsBeta(app, `/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    }),
  });
  if (res.status !== 200) {
    throw new Error(`send message failed: ${res.status} ${await res.text()}`);
  }
}

async function sendCustomToolResult(
  sessionId: string,
  customToolUseId: string,
  result: string,
): Promise<void> {
  const res = await requestWithManagedAgentsBeta(app, `/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [
        {
          type: "user.custom_tool_result",
          custom_tool_use_id: customToolUseId,
          content: [{ type: "text", text: result }],
        },
      ],
    }),
  });
  if (res.status !== 200) {
    throw new Error(`send custom tool result failed: ${res.status} ${await res.text()}`);
  }
}

async function getEvents(path: string): Promise<{
  data: Array<Record<string, unknown>>;
  next_page: string | null;
}> {
  const res = await requestWithManagedAgentsBeta(app, path);
  if (res.status !== 200) {
    throw new Error(`list failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as {
    data: Array<Record<string, unknown>>;
    next_page: string | null;
  };
}

async function eventuallyEvents(
  sessionId: string,
  predicate: (events: Array<Record<string, unknown>>) => boolean,
  label: string,
): Promise<Array<Record<string, unknown>>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < TIMEOUT_MS) {
    const events = (await getEvents(`/v1/sessions/${sessionId}/events?order=asc`)).data;
    if (predicate(events)) return events;
    await sleep(50);
  }
  const events = (await getEvents(`/v1/sessions/${sessionId}/events?order=asc`)).data;
  throw new Error(
    `Timed out waiting for ${label}. Current types: ${events
      .map((event) => event.type)
      .join(",")}`,
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
