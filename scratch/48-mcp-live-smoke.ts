/**
 * Live smoke 48 — plan 0122 M1 end-to-end: a REAL model turn drives a REAL
 * MCP tool call through the full OMA stack (events service → PiSessionRunner
 * → Pi agent loop → MCP bridge → public DeepWiki server), with the
 * PRODUCTION SSRF-guarded fetch (no test seam — DeepWiki is public).
 *
 * This is the one path unit/e2e tests cannot cover hermetically: the model
 * emitting the toolCall and the coalescing/persistence running in the real
 * runOnSession loop.
 *
 * Run:
 *   bash -c 'set -a; source <env-with-ANTHROPIC_API_KEY>; set +a; \
 *     node --experimental-transform-types scratch/48-mcp-live-smoke.ts'
 */
import { SqliteAgentStore } from "../src/control-plane/agents/store.ts";
import { DefaultAgentService } from "../src/control-plane/agents/service.ts";
import { SqliteEnvironmentStore } from "../src/control-plane/environments/store.ts";
import { DefaultEnvironmentService } from "../src/control-plane/environments/service.ts";
import { SqliteSessionStore } from "../src/control-plane/sessions/store.ts";
import { DefaultSessionService } from "../src/control-plane/sessions/service.ts";
import { EventStore } from "../src/control-plane/events/store.ts";
import { SessionEventBroadcaster } from "../src/control-plane/events/broadcaster.ts";
import { DefaultSessionEventsService } from "../src/control-plane/events/service.ts";
import { DefaultFileService } from "../src/control-plane/files/service.ts";
import { InMemoryFileStorage } from "../src/control-plane/files/store.ts";
import { createBestEffortSessionOutputCoordinator } from "../src/control-plane/deployment-session-output-coordinator.ts";
import { createBestEffortRuntimeEventCoordinator } from "../src/control-plane/deployment-runtime-event-coordinator.ts";
import { createControlPlaneApp, MANAGED_AGENTS_BETA } from "../src/control-plane/app.ts";
import { PiSessionRunner } from "../src/control-plane/sessions/pi/runner.ts";
import {
  createStoreBackedMcpServersProvider,
  createStoreBackedMcpToolAccessResolver,
} from "../src/control-plane/sessions/pi/mcp/bridge.ts";
import { translatePiEvent } from "../src/control-plane/sessions/pi/translator.ts";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY required");
  process.exit(2);
}
const MODEL = process.env.OMA_SMOKE_MODEL ?? "claude-sonnet-5";
const MCP_URL = "https://mcp.deepwiki.com/mcp";

const agentStore = SqliteAgentStore.open(":memory:");
const environmentStore = SqliteEnvironmentStore.open(":memory:");
const sessionStore = SqliteSessionStore.open(":memory:");
const eventStore = EventStore.open(":memory:");
const fileStorage = new InMemoryFileStorage();
const broadcaster = new SessionEventBroadcaster(eventStore);

const runner = new PiSessionRunner({
  model: MODEL,
  mcp: {
    enabled: true,
    servers: createStoreBackedMcpServersProvider({
      sessions: sessionStore,
      agents: agentStore,
    }),
    access: createStoreBackedMcpToolAccessResolver({
      sessions: sessionStore,
      agents: agentStore,
    }),
    // PRODUCTION fetch: no allowAddress seam. DeepWiki must pass the guard.
    onConnection: (event) => console.log(`[mcp] connection: ${event}`),
    onToolCall: (outcome) => console.log(`[mcp] tool call: ${outcome}`),
  },
});

const app = createControlPlaneApp({
  agents: new DefaultAgentService(agentStore, undefined),
  environments: new DefaultEnvironmentService(environmentStore),
  files: new DefaultFileService(fileStorage),
  sessions: new DefaultSessionService(
    sessionStore,
    agentStore,
    environmentStore,
    fileStorage,
    {
      assertDeletable: () => {},
      runtime: runner,
      idempotencyLedger: eventStore,
      createSessionRowsWithIdempotency:
        sessionStore.createAndCompleteIdempotency.bind(sessionStore),
    },
  ),
  sessionEvents: new DefaultSessionEventsService(
    eventStore,
    sessionStore,
    broadcaster,
    {
      runner,
      translate: translatePiEvent,
      sessionOutputCoordinator: createBestEffortSessionOutputCoordinator({
        sessions: sessionStore,
        events: eventStore,
        files: fileStorage,
      }),
      runtimeEventCoordinator: createBestEffortRuntimeEventCoordinator({
        sessions: sessionStore,
        events: eventStore,
      }),
    },
  ),
});

const HEADERS = {
  "content-type": "application/json",
  "anthropic-beta": MANAGED_AGENTS_BETA,
};

async function post(path: string, body: unknown): Promise<any> {
  const res = await app.request(path, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

const agent = await post("/v1/agents", {
  name: "mcp-live-smoke",
  model: "claude-opus-4-7",
  system:
    "Use the deepwiki MCP tools when asked. Call the requested tool exactly once, then answer in one short sentence.",
  mcp_servers: [{ type: "url", name: "deepwiki", url: MCP_URL }],
  tools: [
    { type: "agent_toolset_20260401" },
    {
      type: "mcp_toolset",
      mcp_server_name: "deepwiki",
      default_config: { permission_policy: { type: "always_allow" } },
    },
  ],
});
const environment = await post("/v1/environments", {
  name: "mcp-live-smoke",
  config: { type: "cloud", networking: { type: "unrestricted" } },
});
const session = await post("/v1/sessions", {
  agent: agent.id,
  environment_id: environment.id,
});
console.log(`[smoke] model=${MODEL} session=${session.id}`);

await post(`/v1/sessions/${session.id}/events`, {
  events: [
    {
      type: "user.message",
      content: [
        {
          type: "text",
          text: "Call the deepwiki tool read_wiki_structure with repoName 'badlogic/pi-mono' and tell me one top-level topic it lists.",
        },
      ],
    },
  ],
});

const deadline = Date.now() + 180_000;
let frames: any[] = [];
while (Date.now() < deadline) {
  const res = await app.request(`/v1/sessions/${session.id}/events?limit=100`, {
    headers: HEADERS,
  });
  const body = (await res.json()) as { data: any[] };
  frames = body.data;
  const done =
    frames.some((event) => event.type === "agent.mcp_tool_result") &&
    frames.some(
      (event) =>
        event.type === "session.status_idle" &&
        event.stop_reason?.type === "end_turn",
    );
  const failed = frames.some((event) => event.type === "session.error");
  if (done || failed) break;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

const interesting = frames.filter((event) =>
  [
    "agent.mcp_tool_use",
    "agent.mcp_tool_result",
    "session.error",
    "agent.message",
  ].includes(event.type),
);
console.log("=== frames ===");
for (const frame of interesting) {
  const compact = { ...frame };
  if (typeof compact.content?.[0]?.text === "string") {
    compact.content = [
      { ...compact.content[0], text: compact.content[0].text.slice(0, 200) },
    ];
  }
  console.log(JSON.stringify(compact, null, 2));
}

const use = frames.find((event) => event.type === "agent.mcp_tool_use");
const result = frames.find((event) => event.type === "agent.mcp_tool_result");
const ok =
  use !== undefined &&
  result !== undefined &&
  result.mcp_tool_use_id === use.id &&
  result.is_error === false;
console.log(ok ? "=== SMOKE 48 PASS ===" : "=== SMOKE 48 FAIL ===");
runner.close();
process.exit(ok ? 0 : 1);
