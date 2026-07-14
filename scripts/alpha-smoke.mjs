#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const BETA = "managed-agents-2026-04-01";
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_TIMEOUT_MS = 120_000;
const KEY_LINE = /x-api-key: (oma_[A-Za-z0-9_-]+)/;
const URL_LINE = /open-managed-agents listening on (http:\/\/[^\s]+)/;

const state = {
  child: undefined,
  home: undefined,
  keepHome: process.env.OMA_ALPHA_KEEP_HOME === "1",
};

process.on("SIGINT", () => {
  cleanup().finally(() => process.exit(130));
});
process.on("SIGTERM", () => {
  cleanup().finally(() => process.exit(143));
});

try {
  await main();
  await cleanup();
} catch (error) {
  console.error("");
  fail(error instanceof Error ? error.message : String(error));
  await cleanup();
  process.exit(1);
}

async function main() {
  heading("OMA alpha smoke");
  step("Checking local prerequisites");
  checkNode();
  checkDocker();

  const configuredBaseUrl = process.env.OMA_ALPHA_BASE_URL;
  const configuredApiKey = process.env.OMA_ALPHA_API_KEY;
  let baseUrl;
  let apiKey;

  if (configuredBaseUrl || configuredApiKey) {
    if (!configuredBaseUrl || !configuredApiKey) {
      throw new Error("Set both OMA_ALPHA_BASE_URL and OMA_ALPHA_API_KEY, or neither.");
    }
    baseUrl = trimTrailingSlash(configuredBaseUrl);
    apiKey = configuredApiKey;
    ok(`Using existing OMA server at ${baseUrl}`);
  } else {
    const started = await startTemporaryOma();
    baseUrl = started.baseUrl;
    apiKey = started.apiKey;
  }

  await waitForApi(baseUrl, apiKey);

  const model = process.env.OMA_ALPHA_MODEL ?? DEFAULT_MODEL;
  const prefix = `alpha-smoke-${Date.now().toString(36)}`;

  step(`Creating agent (${model})`);
  const agent = await requestJson(baseUrl, apiKey, "/v1/agents", {
    method: "POST",
    body: {
      name: `${prefix}-agent`,
      model,
      system: [
        "You are running the Open Managed Agents alpha smoke test.",
        "Reply with the exact token OMA_ALPHA_SMOKE_OK and no extra prose.",
      ].join(" "),
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: { permission_policy: "always_allow" },
          configs: [
            { name: "web_fetch", enabled: false },
            { name: "web_search", enabled: false },
          ],
        },
      ],
      metadata: { alpha_smoke: "true", prefix },
    },
  });
  ok(`Agent ${agent.id} v${agent.version}`);

  step("Creating default-deny environment");
  const environment = await requestJson(baseUrl, apiKey, "/v1/environments", {
    method: "POST",
    body: {
      name: `${prefix}-environment`,
      config: { networking: { type: "limited", allowed_hosts: [] } },
    },
  });
  ok(`Environment ${environment.id}`);

  step("Creating session");
  const session = await requestJson(baseUrl, apiKey, "/v1/sessions", {
    method: "POST",
    body: {
      agent: agent.id,
      environment_id: environment.id,
      title: "OMA alpha smoke",
      metadata: { alpha_smoke: "true", prefix },
    },
  });
  ok(`Session ${session.id}`);

  step("Sending prompt");
  await requestJson(baseUrl, apiKey, `/v1/sessions/${session.id}/events`, {
    method: "POST",
    body: {
      events: [
        {
          type: "user.message",
          content: [
            {
              type: "text",
              text: "Reply with exactly OMA_ALPHA_SMOKE_OK and no other text.",
            },
          ],
        },
      ],
    },
  });
  ok("Prompt accepted");

  step("Waiting for session result");
  const timeoutMs = parsePositiveInt(process.env.OMA_ALPHA_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const result = await waitForResult(baseUrl, apiKey, session.id, timeoutMs);
  ok(`Observed ${result.eventCount} session events`);
  if (result.agentText.includes("OMA_ALPHA_SMOKE_OK")) {
    ok("Received expected agent.message token");
  } else {
    throw new Error(
      `Session completed, but the final agent.message did not include OMA_ALPHA_SMOKE_OK. Last message: ${JSON.stringify(result.agentText)}`,
    );
  }

  step("Best-effort cleanup");
  await bestEffort(() => requestJson(baseUrl, apiKey, `/v1/sessions/${session.id}`, { method: "DELETE" }));
  await bestEffort(() => requestJson(baseUrl, apiKey, `/v1/agents/${agent.id}/archive`, { method: "POST" }));
  ok("Cleanup attempted");

  console.log("");
  console.log("Alpha smoke passed.");
  console.log(`Console: ${baseUrl}/console`);
}

function checkNode() {
  const [major = 0, minor = 0] = process.versions.node
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Node >= 22.19.0 is required; found ${process.versions.node}`);
  }
  ok(`Node ${process.versions.node}`);
}

function checkDocker() {
  const result = spawnSync("docker", ["info"], { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "docker info failed").trim();
    throw new Error(`Docker is required for the alpha smoke. Start Docker and retry. Detail: ${detail}`);
  }
  ok("Docker daemon reachable");
}

async function startTemporaryOma() {
  state.home = await mkdtemp(join(tmpdir(), "oma-alpha-smoke-"));
  const child = spawn(
    process.execPath,
    ["bin/open-managed-agents.mjs"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OMA_HOME: state.home,
        OMA_HOST: "127.0.0.1",
        OMA_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  state.child = child;

  let logs = "";
  let baseUrl;
  let apiKey;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    logs += chunk;
    baseUrl ??= URL_LINE.exec(logs)?.[1];
    apiKey ??= KEY_LINE.exec(logs)?.[1];
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk;
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    if (child.exitCode !== null) {
      throw new Error(`OMA exited during startup with code ${child.exitCode}.\n${logs.trim()}`);
    }
    if (baseUrl && apiKey) {
      ok(`Started temporary OMA at ${baseUrl}`);
      ok(`Temporary data: ${state.home}`);
      return { baseUrl: trimTrailingSlash(baseUrl), apiKey };
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for OMA startup logs.\n${logs.trim()}`);
}

async function waitForApi(baseUrl, apiKey) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    try {
      const res = await fetch(`${baseUrl}/v1/agents?limit=1`, {
        headers: headers(apiKey),
      });
      if (res.status === 200) {
        ok("API authenticated");
        return;
      }
      if (res.status === 401) {
        throw new Error("API key was rejected by OMA.");
      }
    } catch (error) {
      if (Date.now() - startedAt >= 10_000) throw error;
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for OMA API readiness.");
}

async function waitForResult(baseUrl, apiKey, sessionId, timeoutMs) {
  const startedAt = Date.now();
  let lastTypes = [];
  while (Date.now() - startedAt < timeoutMs) {
    const page = await requestJson(
      baseUrl,
      apiKey,
      `/v1/sessions/${sessionId}/events?order=asc&limit=100`,
      { method: "GET" },
    );
    const events = Array.isArray(page.data) ? page.data : [];
    lastTypes = events.map((event) => event.type);
    const error = events.find((event) => event.type === "session.error");
    if (error) {
      throw new Error(`Session emitted session.error: ${JSON.stringify(error)}`);
    }
    const message = [...events].reverse().find((event) => event.type === "agent.message");
    const idle = events.some((event) => event.type === "session.status_idle");
    if (message && idle) {
      return {
        eventCount: events.length,
        agentText: contentText(message.content),
      };
    }
    await delay(500);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for agent.message + idle. Last event types: ${lastTypes.join(", ") || "(none)"}`);
}

async function requestJson(baseUrl, apiKey, path, opts) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method,
    headers: {
      ...headers(apiKey),
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message = body?.error?.message ?? text ?? res.statusText;
    if (String(message).includes("not available on this deployment")) {
      throw new Error(
        `${message}\n\nSet OMA_ALPHA_MODEL to a model available in your Pi/model registry, or configure provider credentials before running the alpha smoke.`,
      );
    }
    throw new Error(`${opts.method} ${path} failed with HTTP ${res.status}: ${message}`);
  }
  return body;
}

function headers(apiKey) {
  return {
    "anthropic-beta": BETA,
    "x-api-key": apiKey,
  };
}

function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

async function bestEffort(fn) {
  try {
    await fn();
  } catch {
    // The temporary appliance home is removed at the end of the default smoke.
  }
}

async function cleanup() {
  if (state.child !== undefined && state.child.exitCode === null) {
    state.child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => state.child.once("exit", resolve)),
      delay(3_000),
    ]);
    if (state.child.exitCode === null) state.child.kill("SIGKILL");
  }
  if (state.home !== undefined && !state.keepHome) {
    await rm(state.home, { recursive: true, force: true });
  } else if (state.home !== undefined) {
    console.log(`Kept temporary OMA_HOME: ${state.home}`);
  }
}

function parsePositiveInt(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function heading(message) {
  console.log("");
  console.log(message);
  console.log("=".repeat(message.length));
}

function step(message) {
  console.log("");
  console.log(`→ ${message}`);
}

function ok(message) {
  console.log(`✓ ${message}`);
}

function fail(message) {
  console.error(`✗ ${message}`);
}
