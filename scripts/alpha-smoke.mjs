#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startAlphaOpenAICompatibleFixture } from "./alpha-openai-compatible-fixture.mjs";
import {
  LOCAL_ALPHA_API_KEY,
  createLocalCompatibleModelsConfig,
  resolveAlphaModel,
} from "./alpha-smoke-models.mjs";

const BETA = "managed-agents-2026-04-01";
const SMOKE_TOKEN = "OMA_ALPHA_SMOKE_OK";
const EGRESS_COMMAND = [
  "set -euo pipefail",
  "work=/workspace/.oma-egress-smoke",
  "trap 'rm -rf \"$work\"' EXIT",
  "mkdir -p \"$work\"",
  "npm view is-number version --registry=https://registry.npmjs.org >/dev/null",
  "uv venv \"$work/venv\" >/dev/null",
  "uv pip install --python \"$work/venv/bin/python\" packaging==25.0 >/dev/null",
  "git ls-remote https://github.com/octocat/Hello-World.git HEAD >/dev/null",
  "curl -fsSL --max-time 30 -o \"$work/source.zip\" https://github.com/octocat/Hello-World/archive/refs/heads/master.zip",
  "if curl -fsS --max-time 5 https://example.com >/dev/null 2>&1; then echo unexpected-egress >&2; exit 93; fi",
  `printf ${SMOKE_TOKEN}`,
].join("\n");
const DEFAULT_SANDBOX_PROVIDER = "docker-local";
const DEFAULT_TIMEOUT_MS = 120_000;
const KEY_LINE = /x-api-key: (oma_[A-Za-z0-9_-]+)/;
const URL_LINE = /open-managed-agents listening on (http:\/\/[^\s]+)/;

const state = {
  child: undefined,
  fixture: undefined,
  home: undefined,
  logs: "",
  baseUrl: undefined,
  apiKey: undefined,
  sessionId: undefined,
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
  if (state.logs.trim()) console.error(`\nTemporary OMA logs:\n${redactLogs(state.logs.trim().slice(-12_000))}`);
  await cleanup();
  process.exit(1);
}

async function main() {
  heading("OMA alpha smoke");
  step("Checking local prerequisites");
  checkNode();

  const configuredBaseUrl = process.env.OMA_ALPHA_BASE_URL;
  const configuredApiKey = process.env.OMA_ALPHA_API_KEY;
  const localCompatible = process.env.OMA_ALPHA_LOCAL_COMPATIBLE === "1";
  const egressSmoke = process.env.OMA_ALPHA_EGRESS_SMOKE === "1";
  if (egressSmoke && !localCompatible) {
    throw new Error("OMA_ALPHA_EGRESS_SMOKE requires the deterministic local-compatible model fixture");
  }
  if (localCompatible && (configuredBaseUrl || configuredApiKey)) {
    throw new Error("OMA_ALPHA_LOCAL_COMPATIBLE cannot target an existing OMA server");
  }
  const model = resolveAlphaModel(process.env, localCompatible);
  let baseUrl;
  let apiKey;
  let sandboxProvider = "existing-server";

  if (configuredBaseUrl || configuredApiKey) {
    if (!configuredBaseUrl || !configuredApiKey) {
      throw new Error("Set both OMA_ALPHA_BASE_URL and OMA_ALPHA_API_KEY, or neither.");
    }
    baseUrl = trimTrailingSlash(configuredBaseUrl);
    apiKey = configuredApiKey;
    ok(`Using existing OMA server at ${baseUrl}`);
    ok("Skipping local sandbox prerequisite check for existing-server mode");
  } else {
    sandboxProvider = process.env.OMA_ALPHA_SANDBOX_PROVIDER ?? DEFAULT_SANDBOX_PROVIDER;
    checkSandboxPrerequisites(sandboxProvider);
    if (localCompatible) {
      state.fixture = await startAlphaOpenAICompatibleFixture({
        apiKey: LOCAL_ALPHA_API_KEY,
        modelId: model.id,
        token: SMOKE_TOKEN,
        ...(egressSmoke ? { command: EGRESS_COMMAND } : {}),
      });
      ok(`Started deterministic OpenAI-compatible fixture at ${state.fixture.baseUrl}`);
    }
    const started = await startTemporaryOma(sandboxProvider, model, state.fixture?.baseUrl, egressSmoke);
    baseUrl = started.baseUrl;
    apiKey = started.apiKey;
  }

  await waitForApi(baseUrl, apiKey);
  await verifyModelCatalog(baseUrl, apiKey, model);

  const prefix = `alpha-smoke-${Date.now().toString(36)}`;

  step(`Creating agent (${model.provider}/${model.id})`);
  const agent = await requestJson(baseUrl, apiKey, "/v1/agents", {
    method: "POST",
    body: {
      name: `${prefix}-agent`,
      model: model.input,
      system: [
        "You are running the Open Managed Agents alpha smoke test.",
        "You must use the bash tool exactly once.",
        `Run the exact bash command provided by the user. It prints ${SMOKE_TOKEN} only after every check passes.`,
        `After the tool result, reply with the exact token ${SMOKE_TOKEN} and no extra prose.`,
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
  if (agent.model?.provider !== model.provider || agent.model?.id !== model.id) {
    throw new Error(
      `Agent persisted unexpected model ${JSON.stringify(agent.model)}; expected ${model.provider}/${model.id}`,
    );
  }
  ok(`Agent ${agent.id} v${agent.version}`);

  let networking = { type: "limited", allowed_hosts: [] };
  if (egressSmoke) {
    step("Resolving the GitHub + package registries preset");
    const catalog = await requestJson(baseUrl, apiKey, "/v1/environments/networking-presets", { method:"GET" });
    if (catalog.deployment?.egress_supported !== true) {
      throw new Error(`Deployment did not report egress support: ${catalog.deployment?.reason ?? "unknown reason"}`);
    }
    const preset = catalog.presets?.find((candidate) => candidate.id === "github-packages-v1");
    if (!preset) throw new Error("Networking catalog did not contain github-packages-v1");
    networking = preset.networking;
    ok(`Using ${preset.name} (${networking.allowed_hosts.length} allowed hosts)`);
  }

  step(egressSmoke ? "Creating registry-enabled environment" : "Creating default-deny environment");
  const environment = await requestJson(baseUrl, apiKey, "/v1/environments", {
    method: "POST",
    body: {
      name: `${prefix}-environment`,
      config: { networking },
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
  state.sessionId = session.id;
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
              text: egressSmoke
                ? `Use bash exactly once and run this exact command:\n${EGRESS_COMMAND}`
                : `Use bash exactly once and run: printf ${SMOKE_TOKEN}`,
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
  if (result.sawBashToolUse) {
    ok("Observed bash tool_use");
  } else {
    throw new Error(`Session completed without an agent.tool_use for bash. Last event types: ${result.eventTypes.join(", ")}`);
  }
  if (result.toolResultText.includes(SMOKE_TOKEN)) {
    ok("Observed expected bash tool_result output");
  } else {
    throw new Error(
      `Session completed, but no bash agent.tool_result included ${SMOKE_TOKEN}. Last tool result: ${JSON.stringify(result.toolResultText)}`,
    );
  }
  if (result.agentText.includes(SMOKE_TOKEN)) {
    ok("Received expected agent.message token");
  } else {
    throw new Error(
      `Session completed, but the final agent.message did not include ${SMOKE_TOKEN}. Last message: ${JSON.stringify(result.agentText)}`,
    );
  }
  state.fixture?.assertComplete();
  if (state.fixture !== undefined) ok("Observed exact custom provider/model routing across both model requests");

  step("Best-effort cleanup");
  await bestEffort(() => requestJson(baseUrl, apiKey, `/v1/sessions/${session.id}`, { method: "DELETE" }));
  await bestEffort(() => requestJson(baseUrl, apiKey, `/v1/agents/${agent.id}/archive`, { method: "POST" }));
  if (egressSmoke) {
    assertNoSessionDockerResources(session.id);
    ok("No session sandbox, sidecar, or internal network remained after delete");
  }
  ok("Cleanup attempted");

  console.log("");
  console.log("Alpha smoke passed.");
  console.log(`Model: ${model.provider}/${model.id}`);
  console.log(`Sandbox provider: ${sandboxProvider}`);
  if (egressSmoke) console.log("Egress: npm, PyPI/uv, GitHub allowed; unrelated HTTPS denied");
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

function checkSandboxPrerequisites(provider) {
  if (provider === "docker-local") {
    checkDocker();
    return;
  }
  if (provider === "microsandbox-local") {
    checkMicrosandbox();
    return;
  }
  throw new Error(
    `Unsupported OMA_ALPHA_SANDBOX_PROVIDER ${JSON.stringify(provider)}. Use "docker-local" or "microsandbox-local".`,
  );
}

function checkDocker() {
  const result = spawnSync("docker", ["info"], { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "docker info failed").trim();
    throw new Error(`Docker is required for the alpha smoke. Start Docker and retry. Detail: ${detail}`);
  }
  ok("Docker daemon reachable");
}

function checkMicrosandbox() {
  const command = process.env.OMA_MICROSANDBOX_COMMAND ?? "msb";
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `${command} --version failed`).trim();
    throw new Error(
      `Microsandbox is required for OMA_ALPHA_SANDBOX_PROVIDER=microsandbox-local. Install msb or set OMA_MICROSANDBOX_COMMAND. Detail: ${detail}`,
    );
  }
  ok(`Microsandbox CLI reachable (${command})`);
}

async function startTemporaryOma(sandboxProvider, model, localFixtureBaseUrl, egressSmoke) {
  state.home = await mkdtemp(join(tmpdir(), "oma-alpha-smoke-"));
  const modelEnv = {};
  if (localFixtureBaseUrl !== undefined) {
    const piRoot = join(state.home, "pi");
    await mkdir(piRoot, { recursive: true, mode: 0o700 });
    await chmod(state.home, 0o700);
    const modelsPath = join(piRoot, "models.json");
    await writeFile(
      modelsPath,
      `${JSON.stringify(createLocalCompatibleModelsConfig(localFixtureBaseUrl), null, 2)}\n`,
      { mode: 0o600 },
    );
    await chmod(modelsPath, 0o600);
    Object.assign(modelEnv, {
      OMA_MODEL_PROVIDERS: model.provider,
      OMA_DEFAULT_MODEL_PROVIDER: model.provider,
      OMA_DEFAULT_MODEL: model.id,
      OMA_PI_MODELS_FILE: modelsPath,
    });
  }
  const child = spawn(
    process.execPath,
    ["bin/oma.mjs", "up", "--sandbox", sandboxProvider],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OMA_HOME: state.home,
        OMA_HOST: "127.0.0.1",
        OMA_PORT: "0",
        ...(egressSmoke ? { OMA_SANDBOX_OPERATION_TIMEOUT_MS:"120000" } : {}),
        ...modelEnv,
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
    state.logs = logs;
    baseUrl ??= URL_LINE.exec(logs)?.[1];
    apiKey ??= KEY_LINE.exec(logs)?.[1];
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk;
    state.logs = logs;
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    if (child.exitCode !== null) {
      throw new Error(`OMA exited during startup with code ${child.exitCode}.\n${logs.trim()}`);
    }
    if (baseUrl && apiKey) {
      state.baseUrl = trimTrailingSlash(baseUrl);
      state.apiKey = apiKey;
      ok(`Started temporary OMA at ${baseUrl}`);
      ok(`Temporary sandbox provider: ${sandboxProvider}`);
      ok(`Temporary data: ${state.home}`);
      return { baseUrl: trimTrailingSlash(baseUrl), apiKey };
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for OMA startup logs.\n${logs.trim()}`);
}

function assertNoSessionDockerResources(sessionId) {
  const filters = ["container", "network"];
  for (const resource of filters) {
    const args = resource === "container"
      ? ["ps", "-aq", "--filter", `label=open-managed-agents.session-id=${sessionId}`]
      : ["network", "ls", "-q", "--filter", `label=open-managed-agents.session-id=${sessionId}`];
    const result = spawnSync("docker", args, { encoding:"utf8" });
    if (result.status !== 0) throw new Error(`Could not inspect Docker ${resource} cleanup: ${result.stderr || result.stdout}`);
    if (result.stdout.trim() !== "") throw new Error(`Docker ${resource} resources remain for ${sessionId}: ${result.stdout.trim()}`);
  }
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

async function verifyModelCatalog(baseUrl, apiKey, model) {
  const page = await requestJson(
    baseUrl,
    apiKey,
    `/v1/model-catalog?provider=${encodeURIComponent(model.provider)}&limit=100`,
    { method: "GET" },
  );
  const entry = page.data?.find((candidate) => candidate.provider === model.provider && candidate.id === model.id);
  if (!entry) throw new Error(`Model catalog did not contain ${model.provider}/${model.id}`);
  if (entry.credentials_configured !== true) {
    throw new Error(`Model catalog reported missing credentials for ${model.provider}/${model.id}`);
  }
  const serialized = JSON.stringify(page);
  for (const forbidden of ["baseUrl", "headers", "authPath", "modelsPath", "apiKey", "Authorization", LOCAL_ALPHA_API_KEY]) {
    if (serialized.includes(forbidden)) throw new Error(`Model catalog leaked forbidden field/value ${forbidden}`);
  }
  ok(`Model catalog reports ${model.provider}/${model.id} ready without configuration internals`);
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
    const bashToolUse = events.find(
      (event) => event.type === "agent.tool_use" && event.name === "bash",
    );
    const toolResults = events.filter((event) => event.type === "agent.tool_result");
    const idle = events.some((event) => event.type === "session.status_idle");
    if (message && idle) {
      return {
        eventCount: events.length,
        eventTypes: lastTypes,
        sawBashToolUse: bashToolUse !== undefined,
        toolResultText: toolResults.map((event) => contentText(event.content)).join("\n"),
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
  if (
    state.child !== undefined &&
    state.child.exitCode === null &&
    state.baseUrl !== undefined &&
    state.apiKey !== undefined &&
    state.sessionId !== undefined
  ) {
    await bestEffort(() => requestJson(
      state.baseUrl,
      state.apiKey,
      `/v1/sessions/${state.sessionId}`,
      { method:"DELETE" },
    ));
    state.sessionId = undefined;
  }
  if (state.child !== undefined && state.child.exitCode === null) {
    state.child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => state.child.once("exit", resolve)),
      delay(3_000),
    ]);
    if (state.child.exitCode === null) state.child.kill("SIGKILL");
  }
  if (state.fixture !== undefined) {
    await state.fixture.close();
    state.fixture = undefined;
  }
  if (state.home !== undefined && !state.keepHome) {
    await rm(state.home, { recursive: true, force: true });
  } else if (state.home !== undefined) {
    console.log(`Kept temporary OMA_HOME: ${state.home}`);
  }
}

function redactLogs(value) {
  return value.replace(/oma_[A-Za-z0-9_-]+/g, "[redacted-workspace-key]");
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
