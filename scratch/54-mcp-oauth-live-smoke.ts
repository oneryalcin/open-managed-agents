/**
 * Live smoke 54 — real deployment composition, real model turns, OAuth
 * refresh/401 recovery, validate matrix, redirect blocking, and leak sweep.
 *
 * Run:
 *   bash -c 'set -a; source /Users/oner/dev/junk/cwc-workshops/.env; set +a; \
 *     node --experimental-transform-types scratch/54-mcp-oauth-live-smoke.ts'
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createDeploymentControlPlane, MANAGED_AGENTS_BETA } from "../src/control-plane/app.ts";
import { generateMasterKey } from "../src/control-plane/secrets/master-key.ts";
import { startMcpFixture } from "../src/control-plane/sessions/pi/mcp/__tests__/fixture.ts";
import { createGuardedMcpFetch } from "../src/control-plane/sessions/pi/mcp/fetch.ts";
import { probeMcpInitialize } from "../src/control-plane/sessions/pi/mcp/probe.ts";
import { RefreshCoordinator } from "../src/control-plane/vaults/oauth-refresh.ts";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY required");
  process.exit(2);
}

const capturedLogs: string[] = [];
const originalConsole = {
  log: console.log.bind(console),
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
for (const level of ["log", "debug", "info", "warn", "error"] as const) {
  console[level] = (...args: unknown[]) => {
    capturedLogs.push(logArgs(args));
    originalConsole[level](...args);
  };
}

const MODEL = process.env.OMA_SMOKE_MODEL ?? "claude-haiku-4-5";
const nonce = randomBytes(6).toString("hex");
const ACCESS = [0, 1, 2].map((n) => `access+/${n}=&?%_${nonce}`);
const REFRESH = [0, 1, 2].map((n) => `refresh+/${n}=&?%_${nonce}`);
const CLIENT_SECRET = `client+secret/=&?%_${nonce}`;
let acceptedAccess = ACCESS[1]!;
let previousAccess = ACCESS[0]!;
let refreshIndex = 0;
let tokenPosts = 0;

const tokenServer = createServer(async (req, res) => {
  if (req.url === "/redirect") {
    res.writeHead(302, { location: "/token" }).end();
    return;
  }
  if (req.url === "/oversized") {
    const prefix = Buffer.from("x".repeat(4095));
    const suffix = Buffer.from("€secret-tail");
    res.writeHead(500, {
      "content-type": "text/plain",
      "content-length": String(prefix.length + suffix.length),
    });
    res.write(prefix);
    res.write(suffix.subarray(0, 2));
    res.end(suffix.subarray(2));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  for await (const _chunk of req) { /* consume secret-bearing form */ }
  if (req.url === "/invalid") {
    tokenPosts += 1;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: "invalid_grant",
      reflected_authorization: req.headers.authorization ?? null,
    }));
    return;
  }
  if (req.url === "/transient") {
    tokenPosts += 1;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "server_error" }));
    return;
  }
  if (req.url !== "/token") {
    res.writeHead(404).end();
    return;
  }
  tokenPosts += 1;
  refreshIndex = Math.min(refreshIndex + 1, ACCESS.length - 1);
  previousAccess = acceptedAccess;
  acceptedAccess = ACCESS[refreshIndex]!;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    access_token: acceptedAccess,
    refresh_token: REFRESH[refreshIndex],
    expires_in: 2,
    token_type: "Bearer",
  }));
});
await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
const tokenAddress = tokenServer.address();
if (tokenAddress === null || typeof tokenAddress === "string") throw new Error("token fixture bind failed");
const tokenBase = `http://127.0.0.1:${tokenAddress.port}`;

const mcp = await startMcpFixture([{
  name: "oauth_echo",
  description: "Echo text and hostile token reflections",
  inputSchema: { text: z.string() },
  handler: async (args) => ({
    content: [{
      type: "text",
      text: [
        `echo=${String(args.text)}`,
        `current=${acceptedAccess}`,
        `previous=${previousAccess}`,
        `encoded_current=${encodeURIComponent(acceptedAccess)}`,
        `encoded_previous=${encodeURIComponent(previousAccess)}`,
      ].join(" "),
    }],
  }),
}], { requireBearer: () => acceptedAccess });
const validMcp = await startMcpFixture([], { requireBearer: ACCESS[0] });
const invalidMcp = await startMcpFixture([], { requireBearer: "never-valid" });
const unknownMcp = await startMcpFixture([], { requireBearer: "never-valid" });

const guardedFetch = createGuardedMcpFetch({ allowAddress: () => true });
const home = mkdtempSync(join(tmpdir(), "oma-oauth-smoke-"));
const plane = createDeploymentControlPlane(
  {
    OMA_AUTH_MODE: "api-key",
    OMA_MASTER_KEY: generateMasterKey(),
    OMA_SQLITE_PATH: join(home, "oma.sqlite"),
    OMA_FILE_STORAGE_ROOT: join(home, "files"),
    OMA_SANDBOX_PROVIDER: "none",
    OMA_ENABLE_MCP: "true",
  },
  {
    testMcp: {
      fetch: guardedFetch,
      allowInsecureTokenEndpoint: (url) => url.hostname === "127.0.0.1",
    },
  },
);
const apiKey = plane.stores.workspaces.mintKey("wrk_default", "smoke").plaintextKey;
const headers = {
  "content-type": "application/json",
  "anthropic-beta": MANAGED_AGENTS_BETA,
  "x-api-key": apiKey,
};
const apiResponses: unknown[] = [];

async function post(path: string, body: unknown): Promise<any> {
  const response = await plane.app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (response.status !== 200) throw new Error(`${path} -> ${response.status}: ${await response.text()}`);
  const parsed = await response.json();
  apiResponses.push(parsed);
  return parsed;
}

async function oauthCredential(
  name: string,
  mcpUrl: string,
  tokenEndpoint: string | undefined,
  authType: "client_secret_post" | "client_secret_basic" = "client_secret_post",
): Promise<{ vaultId: string; credentialId: string }> {
  const vault = await post("/v1/vaults", { display_name: name });
  const credential = await post(`/v1/vaults/${vault.id}/credentials`, {
    auth: {
      type: "mcp_oauth",
      mcp_server_url: mcpUrl,
      access_token: ACCESS[0],
      ...(tokenEndpoint === undefined
        ? {}
        : {
            refresh: {
              token_endpoint: tokenEndpoint,
              client_id: "smoke-client",
              refresh_token: REFRESH[0],
              token_endpoint_auth: {
                type: authType,
                client_secret: CLIENT_SECRET,
              },
            },
          }),
    },
  });
  return { vaultId: vault.id, credentialId: credential.id };
}

const validCredential = await oauthCredential("Valid", validMcp.url, undefined);
const invalidCredential = await oauthCredential(
  "Invalid",
  invalidMcp.url,
  `${tokenBase}/invalid`,
  "client_secret_basic",
);
const unknownCredential = await oauthCredential("Unknown", unknownMcp.url, `${tokenBase}/transient`);
const validate = async (credential: { vaultId: string; credentialId: string }) =>
  post(`/v1/vaults/${credential.vaultId}/credentials/${credential.credentialId}/mcp_oauth_validate`, {});
const validations = {
  valid: await validate(validCredential),
  invalid: await validate(invalidCredential),
  unknown: await validate(unknownCredential),
};

const mainVault = await post("/v1/vaults", { display_name: "OAuth turns" });
const mainCredential = await post(`/v1/vaults/${mainVault.id}/credentials`, {
  auth: {
    type: "mcp_oauth",
    mcp_server_url: mcp.url,
    access_token: ACCESS[0],
    expires_at: new Date(Date.now() + 1_000).toISOString(),
    refresh: {
      token_endpoint: `${tokenBase}/token`,
      client_id: "smoke-client",
      refresh_token: REFRESH[0],
      token_endpoint_auth: { type: "client_secret_post", client_secret: CLIENT_SECRET },
    },
  },
});
const agent = await post("/v1/agents", {
  name: "mcp-oauth-live-smoke",
  model: "claude-opus-4-7",
  system: "Call oauth_echo exactly once for each user request, then answer briefly.",
  mcp_servers: [{ type: "url", name: "oauth", url: mcp.url }],
  tools: [
    { type: "agent_toolset_20260401" },
    { type: "mcp_toolset", mcp_server_name: "oauth", default_config: { permission_policy: { type: "always_allow" } } },
  ],
});
const environment = await post("/v1/environments", {
  name: "oauth-smoke",
  config: { type: "cloud", networking: { type: "unrestricted" } },
});
const session = await post("/v1/sessions", {
  agent: agent.id,
  environment_id: environment.id,
  vault_ids: [mainVault.id],
});

await new Promise((resolve) => setTimeout(resolve, 1_100));
await turn("lazy-refresh");
await new Promise((resolve) => setTimeout(resolve, 2_100));
await turn("warm-handle-refresh");
const beforeForced = tokenPosts;
acceptedAccess = "revoked-by-fixture";
await turn("forced-401-refresh");
const forcedPosts = tokenPosts - beforeForced;

const redirectVault = await post("/v1/vaults", { display_name: "Redirect" });
const redirectCredential = await post(`/v1/vaults/${redirectVault.id}/credentials`, {
  auth: {
    type: "mcp_oauth",
    mcp_server_url: invalidMcp.url,
    access_token: ACCESS[0],
    refresh: {
      token_endpoint: `${tokenBase}/redirect`,
      client_id: "redirect-client",
      refresh_token: REFRESH[0],
      token_endpoint_auth: { type: "none" },
    },
  },
});
const redirect = await new RefreshCoordinator({
  store: plane.stores.vaults,
  fetch: guardedFetch,
}).refreshCredential({
  workspaceId: "wrk_default",
  vaultId: redirectVault.id,
  credentialId: redirectCredential.id,
  trigger: "validate",
  expectedAuthVersion: 1,
});
const oversized = await probeMcpInitialize(
  `${tokenBase}/oversized`,
  undefined,
  guardedFetch,
  { capBytes: 4096, timeoutMs: 5_000 },
);

const events = await allEvents(session.id);
const serialized = JSON.stringify({ events, apiResponses, capturedLogs, validations, redirect });
const secretForms = [ACCESS, REFRESH, [CLIENT_SECRET]].flat().flatMap((value) => [
  value,
  `Bearer ${value}`,
  encodeURIComponent(value),
  JSON.stringify(value).slice(1, -1),
  Buffer.from(value).toString("base64"),
]);
secretForms.push(
  Buffer.from(`${formComponent("smoke-client")}:${formComponent(CLIENT_SECRET)}`).toString("base64"),
);
const leaks = secretForms.filter((value) => serialized.includes(value));
const summary = {
  ok:
    leaks.length === 0 &&
    forcedPosts === 1 &&
    validations.valid.status === "valid" &&
    validations.invalid.status === "invalid" &&
    validations.unknown.status === "unknown" &&
    redirect.outcome === "transient_error" &&
    redirect.reason === "redirect_blocked" &&
    oversized.reached &&
    oversized.bodyTruncated &&
    mcp.authorizations.some((entry) => entry.authorization === `Bearer ${ACCESS[1]}`) &&
    mcp.authorizations.some((entry) => entry.authorization === `Bearer ${ACCESS[2]}`),
  model: MODEL,
  session_id: session.id,
  credential_id: mainCredential.id,
  token_endpoint_posts: tokenPosts,
  forced_401_posts: forcedPosts,
  validation_statuses: {
    valid: validations.valid.status,
    invalid: validations.invalid.status,
    unknown: validations.unknown.status,
  },
  redirect_reason: redirect.outcome === "transient_error" ? redirect.reason : null,
  oversized_probe_truncated: oversized.reached && oversized.bodyTruncated,
  token_in_events_or_responses_or_logs: leaks.length > 0,
  leak_count: leaks.length,
  event_types: events.map((event: any) => event.type),
};
const artifactDir = join(process.cwd(), "scratch", "artifacts", "mcp-oauth-live-smoke");
mkdirSync(artifactDir, { recursive: true });
writeFileSync(join(artifactDir, "_summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

await plane.close();
await Promise.all([mcp.close(), validMcp.close(), invalidMcp.close(), unknownMcp.close()]);
tokenServer.closeAllConnections?.();
await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
rmSync(home, { recursive: true, force: true });
process.exit(summary.ok ? 0 : 1);

async function turn(label: string): Promise<void> {
  const prior = (await allEvents(session.id)).filter((event: any) => event.type === "agent.mcp_tool_result").length;
  await post(`/v1/sessions/${session.id}/events`, {
    events: [{ type: "user.message", content: [{ type: "text", text: `Call oauth_echo with '${label}'.` }] }],
  });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const events = await allEvents(session.id);
    if (events.some((event: any) => event.type === "session.error")) throw new Error(`${label}: session.error`);
    if (events.filter((event: any) => event.type === "agent.mcp_tool_result").length > prior &&
        events.at(-1)?.type === "session.status_idle") return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label}: timed out`);
}

async function allEvents(sessionId: string): Promise<any[]> {
  const events: any[] = [];
  let page: string | undefined;
  do {
    const query = new URLSearchParams({ limit: "1000" });
    if (page !== undefined) query.set("page", page);
    const response = await plane.app.request(`/v1/sessions/${sessionId}/events?${query}`, { headers });
    const body = await response.json() as { data: any[]; next_page: string | null };
    events.push(...body.data);
    page = body.next_page ?? undefined;
  } while (page !== undefined);
  return events;
}

function logArgs(args: unknown[]): string {
  return args.map((arg) => {
    if (typeof arg === "string") return arg;
    try { return JSON.stringify(arg); } catch { return String(arg); }
  }).join(" ");
}

function formComponent(value: string): string {
  return new URLSearchParams({ x: value }).toString().slice(2);
}
