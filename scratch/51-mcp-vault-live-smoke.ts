/**
 * Live smoke 51 — plan 0122 M2 end-to-end: a REAL model turn drives a REAL
 * MCP tool call through OMA's vault-backed static_bearer credential path.
 *
 * What this proves:
 * - session.vault_ids reaches runtime MCP credential resolution;
 * - the MCP SDK sends Authorization to a bearer-protected streamable-HTTP
 *   server;
 * - the tool call succeeds through the full events service + Pi runner path;
 * - the bearer token is absent from persisted event JSON.
 *
 * This smoke uses a local MCP fixture, so the runner gets the production MCP
 * stack with the SSRF allowAddress seam opened for loopback only. MCP tools
 * are control-plane side in OMA; there is no sandbox-side MCP credential to
 * grep.
 *
 * Run:
 *   bash -c 'set -a; source /Users/oner/dev/junk/cwc-workshops/.env; set +a; \
 *     node --experimental-transform-types scratch/51-mcp-vault-live-smoke.ts'
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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
import { SqliteSecretsStore } from "../src/control-plane/secrets/store.ts";
import { DefaultSecretsService } from "../src/control-plane/secrets/service.ts";
import { SqliteVaultStore } from "../src/control-plane/vaults/store.ts";
import { DefaultVaultService } from "../src/control-plane/vaults/service.ts";
import { createBestEffortSessionOutputCoordinator } from "../src/control-plane/deployment-session-output-coordinator.ts";
import { createBestEffortRuntimeEventCoordinator } from "../src/control-plane/deployment-runtime-event-coordinator.ts";
import { createControlPlaneApp, MANAGED_AGENTS_BETA } from "../src/control-plane/app.ts";
import { PiSessionRunner } from "../src/control-plane/sessions/pi/runner.ts";
import { createGuardedMcpFetch } from "../src/control-plane/sessions/pi/mcp/fetch.ts";
import {
  createStoreBackedMcpCredentialResolver,
  createStoreBackedMcpServersProvider,
  createStoreBackedMcpToolAccessResolver,
} from "../src/control-plane/sessions/pi/mcp/bridge.ts";
import { translatePiEvent } from "../src/control-plane/sessions/pi/translator.ts";
import {
  echoTool,
  startMcpFixture,
} from "../src/control-plane/sessions/pi/mcp/__tests__/fixture.ts";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY required");
  process.exit(2);
}

const MODEL = process.env.OMA_SMOKE_MODEL ?? "claude-haiku-4-5";
const TOKEN = `M2_VAULT_TOKEN_${randomBytes(8).toString("hex")}`;
const ARTIFACT_DIR = join(process.cwd(), "scratch", "artifacts", "mcp-vault-live-smoke");
mkdirSync(ARTIFACT_DIR, { recursive: true });

const fixture = await startMcpFixture([echoTool()], {
  requireBearer: TOKEN,
});

const agentStore = SqliteAgentStore.open(":memory:");
const environmentStore = SqliteEnvironmentStore.open(":memory:");
const sessionStore = SqliteSessionStore.open(":memory:");
const eventStore = EventStore.open(":memory:");
const fileStorage = new InMemoryFileStorage();
const vaultDb = new DatabaseSync(":memory:");
const secrets = new SqliteSecretsStore(vaultDb, randomBytes(32));
const vaultStore = new SqliteVaultStore(vaultDb, secrets);
const vaultService = new DefaultVaultService(vaultStore);
const broadcaster = new SessionEventBroadcaster(eventStore);

const runner = new PiSessionRunner({
  model: MODEL,
  mcp: {
    enabled: true,
    servers: createStoreBackedMcpServersProvider({
      sessions: sessionStore,
      agents: agentStore,
    }),
    credentials: createStoreBackedMcpCredentialResolver({
      sessions: sessionStore,
      vaults: vaultService,
    }),
    access: createStoreBackedMcpToolAccessResolver({
      sessions: sessionStore,
      agents: agentStore,
    }),
    fetch: createGuardedMcpFetch({ allowAddress: () => true }),
    onConnection: (event) => console.log(`[mcp] connection: ${event}`),
    onToolCall: (outcome) => console.log(`[mcp] tool call: ${outcome}`),
  },
});

const app = createControlPlaneApp({
  agents: new DefaultAgentService(agentStore, undefined),
  environments: new DefaultEnvironmentService(environmentStore),
  files: new DefaultFileService(fileStorage),
  secrets: new DefaultSecretsService(secrets),
  vaults: vaultService,
  sessions: new DefaultSessionService(
    sessionStore,
    agentStore,
    environmentStore,
    fileStorage,
    {
      runtime: runner,
      vaults: vaultService,
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

const vault = vaultService.createVault("wrk_default", {
  display_name: "MCP vault smoke",
});
vaultService.createCredential("wrk_default", vault.id, {
  auth: {
    type: "static_bearer",
    mcp_server_url: fixture.url,
    token: TOKEN,
  },
});

const agent = await post("/v1/agents", {
  name: "mcp-vault-live-smoke",
  model: "claude-opus-4-7",
  system:
    "Use the configured MCP echo tool when asked. Call it exactly once, then answer in one short sentence.",
  mcp_servers: [{ type: "url", name: "vaulted", url: fixture.url }],
  tools: [
    { type: "agent_toolset_20260401" },
    {
      type: "mcp_toolset",
      mcp_server_name: "vaulted",
      default_config: { permission_policy: { type: "always_allow" } },
    },
  ],
});
const environment = await post("/v1/environments", {
  name: "mcp-vault-live-smoke",
  config: { type: "cloud", networking: { type: "unrestricted" } },
});
const session = await post("/v1/sessions", {
  agent: agent.id,
  environment_id: environment.id,
  vault_ids: [vault.id],
});
console.log(`[smoke] model=${MODEL} session=${session.id} vault=${vault.id}`);

await post(`/v1/sessions/${session.id}/events`, {
  events: [
    {
      type: "user.message",
      content: [
        {
          type: "text",
          text: "Call the MCP echo tool with text 'M2_VAULT_SMOKE_OK'.",
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

const eventJson = JSON.stringify(frames);
const use = frames.find((event) => event.type === "agent.mcp_tool_use");
const result = frames.find((event) => event.type === "agent.mcp_tool_result");
const ok =
  use !== undefined &&
  result !== undefined &&
  result.mcp_tool_use_id === use.id &&
  result.is_error === false &&
  fixture.toolCalls.length === 1 &&
  fixture.authorizations.length > 0 &&
  fixture.authorizations.every(
    (entry) => entry.authorization === `Bearer ${TOKEN}`,
  ) &&
  !eventJson.includes(TOKEN);

const summary = {
  ok,
  model: MODEL,
  session_id: session.id,
  vault_id: vault.id,
  mcp_tool_calls: fixture.toolCalls,
  observed_authorization_methods: fixture.authorizations.map((entry) => entry.method),
  token_in_events: eventJson.includes(TOKEN),
  event_types: frames.map((event) => event.type),
};
writeFileSync(
  join(ARTIFACT_DIR, "_summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
console.log(ok ? "=== SMOKE 51 PASS ===" : "=== SMOKE 51 FAIL ===");

runner.close();
await fixture.close();
vaultDb.close();
process.exit(ok ? 0 : 1);
