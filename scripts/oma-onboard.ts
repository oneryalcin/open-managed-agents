import * as p from "@clack/prompts";
import pc from "picocolors";
import { stdin as input } from "node:process";
import { spawnSync } from "node:child_process";
import {
  inspectOma,
  type DoctorReport,
} from "./oma-doctor.ts";
import { runModelsCli } from "./oma-models.ts";
import { DEFAULT_OMA_SANDBOX_IMAGE } from "../src/control-plane/sessions/pi/sandbox/image.ts";
import { resolveOmaUpEgressEnvironment } from "../src/control-plane/egress/image.ts";
import { ConsoleBootstrapService } from "../src/control-plane/console/bootstrap.ts";
import { startAppliance } from "../src/main.ts";
import { ensureStarterResources } from "./oma-onboarding-resources.ts";

export const ONBOARD_CANCELLED = Symbol("oma-onboard-cancelled");

type PromptValue<T> = T | typeof ONBOARD_CANCELLED;
type Sandbox = "docker-local" | "microsandbox-local";

export interface OnboardTerminal {
  intro(message: string): void;
  step(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  outro(message: string): void;
  cancel(message: string): void;
  select(options: { message: string; options: Array<{ value: string; label: string; hint?: string }> }): Promise<PromptValue<string>>;
  confirm(options: { message: string; initialValue: boolean }): Promise<PromptValue<boolean>>;
  password(options: { message: string; validate(value: string): string | undefined }): Promise<PromptValue<string>>;
}

export interface OnboardRuntime {
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  terminal: OnboardTerminal;
  inspect(options: { sandbox: Sandbox }): Promise<DoctorReport>;
  providerStatus(provider?: string): Promise<{ providers: string[]; stored: boolean | undefined }>;
  storeCredential(provider: string, key: string): Promise<void>;
  readStdin(): Promise<string>;
  launch(
    provider: string,
    sandbox: Sandbox,
    options: { json: boolean; onReady(sessionId: string): void },
  ): Promise<{ sessionId: string }>;
}

export interface OnboardResult {
  code: 0 | 1 | 2 | 130;
  provider?: string;
  credential: "stored" | "reused" | "not_reached";
  report?: DoctorReport;
  sessionId?: string;
}

interface OnboardOptions {
  provider?: string;
  stdin: boolean;
  json: boolean;
  sandbox: Sandbox;
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

export async function runOnboard(
  argv: readonly string[],
  runtime: OnboardRuntime,
): Promise<OnboardResult> {
  const wantsJson = argv.includes("--json");
  let options: OnboardOptions;
  try {
    options = parseOnboardArgs(argv);
  } catch (error) {
    emitFailure(runtime, wantsJson, error instanceof Error ? error.message : String(error));
    return { code: 2, credential: "not_reached" };
  }

  if (!runtime.interactive && !options.stdin && options.provider === undefined) {
    emitFailure(runtime, options.json, "Non-interactive onboarding requires --provider and either --stdin or an existing stored credential.");
    return { code: 2, credential: "not_reached" };
  }

  if (options.stdin && options.provider === undefined) {
    emitFailure(runtime, options.json, "--stdin requires --provider so OMA knows which credential to store.");
    return { code: 2, credential: "not_reached" };
  }

  if (!options.json) runtime.terminal.intro(pc.bgCyan(pc.black(" Open Managed Agents ")));

  const report = await runtime.inspect({ sandbox: options.sandbox });
  const failures = onboardingPreflightFailures(report, options.sandbox);
  if (failures.length > 0) {
    const detail = failures.join("\n");
    emitFailure(runtime, options.json, detail);
    return { code: 1, credential: "not_reached", report };
  }
  if (!options.json) runtime.terminal.step("Docker and the cached OMA sandbox image are ready.");

  let provider = options.provider;
  let providerState;
  try {
    providerState = await runtime.providerStatus(provider);
  } catch (error) {
    emitFailure(runtime, options.json, safeMessage(error));
    return { code: 2, credential: "not_reached", report };
  }

  if (providerState.providers.length === 0) {
    emitFailure(runtime, options.json, "No enabled model providers are available for onboarding.");
    return { code: 2, credential: "not_reached", report };
  }

  if (provider === undefined) {
    if (!runtime.interactive) {
      emitFailure(runtime, options.json, "Non-interactive onboarding requires --provider.");
      return { code: 2, credential: "not_reached", report };
    }
    const selected = await runtime.terminal.select({
      message: "Choose a model provider",
      options: providerState.providers.map((value) => ({
        value,
        label: PROVIDER_LABELS[value] ?? value,
      })),
    });
    if (selected === ONBOARD_CANCELLED) return cancelled(runtime, options.json, report);
    provider = selected;
    try {
      providerState = await runtime.providerStatus(provider);
    } catch (error) {
      emitFailure(runtime, options.json, safeMessage(error));
      return { code: 2, credential: "not_reached", report };
    }
  }

  if (!providerState.providers.includes(provider)) {
    emitFailure(runtime, options.json, `Model provider ${JSON.stringify(provider)} is not enabled. Enabled providers: ${providerState.providers.join(", ")}.`);
    return { code: 2, credential: "not_reached", report };
  }

  if (providerState.stored) {
    if (!runtime.interactive || options.json) {
      return finishOnboarding(runtime, options, provider, "reused", report);
    }
    const reuse = await runtime.terminal.confirm({
      message: `Use the saved ${PROVIDER_LABELS[provider] ?? provider} credential?`,
      initialValue: true,
    });
    if (reuse === ONBOARD_CANCELLED) return cancelled(runtime, options.json, report);
    if (reuse) {
      return finishOnboarding(runtime, options, provider, "reused", report);
    }
  }

  let key: string | typeof ONBOARD_CANCELLED;
  if (options.stdin) {
    try {
      key = await runtime.readStdin();
    } catch (error) {
      emitFailure(runtime, options.json, safeMessage(error));
      return { code: 2, credential: "not_reached", report };
    }
  } else if (runtime.interactive) {
    key = await runtime.terminal.password({
      message: `Paste API key for ${PROVIDER_LABELS[provider] ?? provider}`,
      validate(value) {
        return value.trim() === "" ? "API key must not be empty." : undefined;
      },
    });
  } else {
    emitFailure(runtime, options.json, "Non-interactive onboarding requires --stdin when no stored credential exists.");
    return { code: 2, credential: "not_reached", report };
  }

  if (key === ONBOARD_CANCELLED) return cancelled(runtime, options.json, report);
  if (key.trim() === "") {
    emitFailure(runtime, options.json, "API key must not be empty.");
    return { code: 2, credential: "not_reached", report };
  }

  try {
    await runtime.storeCredential(provider, key.trim());
  } catch (error) {
    emitFailure(runtime, options.json, safeMessage(error));
    return { code: 1, credential: "not_reached", report };
  }
  return finishOnboarding(runtime, options, provider, "stored", report);
}

async function finishOnboarding(
  runtime: OnboardRuntime,
  options: OnboardOptions,
  provider: string,
  credential: "stored" | "reused",
  report: DoctorReport,
): Promise<OnboardResult> {
  try {
    let readyEmitted = false;
    const launched = await runtime.launch(provider, options.sandbox, {
      json: options.json,
      onReady(sessionId) {
        readyEmitted = true;
        emitSuccess(runtime, options.json, provider, credential, sessionId);
      },
    });
    if (!readyEmitted) emitSuccess(runtime, options.json, provider, credential, launched.sessionId);
    return { code: 0, provider, credential, report, sessionId: launched.sessionId };
  } catch (error) {
    emitFailure(runtime, options.json, safeMessage(error));
    return { code: 1, provider, credential, report };
  }
}

export function createProcessOnboardRuntime(): OnboardRuntime {
  return {
    env: process.env,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    terminal: createClackTerminal(),
    inspect: (options) => inspectOma(options, { env: process.env }),
    async providerStatus(provider) {
      const status = await runModelsCli(["providers-status"], { env: process.env });
      if (status.code !== 0) throw new Error(status.stderr.trim());
      const providers = parseProviderStatus(status.stdout);
      if (provider === undefined) return { providers, stored: undefined };
      const auth = await runModelsCli(["auth-status", provider], { env: process.env });
      if (auth.code !== 0) throw new Error(auth.stderr.trim());
      return { providers, stored: parseStoredCredential(auth.stdout, provider) };
    },
    async storeCredential(provider, key) {
      const result = await runModelsCli(["auth-set", provider], {
        env: process.env,
        promptSecret: async () => key,
      });
      if (result.code !== 0) throw new Error(result.stderr.trim());
    },
    readStdin: readOneSecretFromStdin,
    launch: (provider, sandbox, options) => launchLocalOnboarding(provider, sandbox, process.env, createClackTerminal(), options),
  };
}

export async function launchLocalOnboarding(
  provider: string,
  sandbox: Sandbox,
  env: NodeJS.ProcessEnv,
  terminal: OnboardTerminal,
  options: { json: boolean; onReady(sessionId: string): void },
): Promise<{ sessionId: string }> {
  const bootstrap = new ConsoleBootstrapService();
  const runtimeEnv = resolveOmaUpEgressEnvironment(env, sandbox);
  const applianceEnv = {
    ...runtimeEnv,
    OMA_AUTH_MODE: "api-key",
    OMA_HOST: "127.0.0.1",
    OMA_PORT: runtimeEnv.OMA_PORT ?? "0",
    OMA_TLS_TERMINATED: "0",
    OMA_SANDBOX_PROVIDER: sandbox,
    ...(sandbox === "docker-local"
      ? { OMA_ALLOW_DOCKER_LOCAL: "true" }
      : { OMA_ALLOW_MICROSANDBOX_LOCAL: "true" }),
  };
  if (!options.json) terminal.step("Starting local OMA");
  const appliance = await startAppliance(applianceEnv, {
    log: () => undefined,
    onboarding: { bootstrap },
  });
  try {
    if (appliance.onboarding === undefined) throw new Error("Local onboarding requires workspace authentication");
    if (!options.json) terminal.step("Preparing your first session");
    const starter = await ensureStarterResources({
      baseUrl: appliance.baseUrl,
      workspaceKey: appliance.onboarding.workspaceKey,
      provider,
    });
    if (!options.json) for (const warning of starter.warnings) terminal.warn(warning);
    const url = `${appliance.baseUrl}/console/#bootstrap=${encodeURIComponent(appliance.onboarding.bootstrapNonce)}&session=${encodeURIComponent(starter.sessionId)}`;
    const opened = openBrowser(url);
    if (!opened && !options.json) terminal.warn(`Browser launch failed. Open this local URL manually: ${url}`);
    options.onReady(starter.sessionId);
    if (!options.json) terminal.outro(`Ready — ${opened ? "console opened" : "console available"} at ${appliance.baseUrl}/console/\nPress Ctrl-C to stop OMA.`);
    await waitForShutdownSignal();
    return { sessionId: starter.sessionId };
  } finally {
    await appliance.close();
  }
}

function openBrowser(url: string): boolean {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

function createClackTerminal(): OnboardTerminal {
  return {
    intro: p.intro,
    step: (message) => p.log.success(message),
    warn: (message) => p.log.warn(message),
    error: (message) => p.log.error(message),
    outro: p.outro,
    cancel: p.cancel,
    async select(options) {
      const selected = await p.select(options);
      return p.isCancel(selected) ? ONBOARD_CANCELLED : selected;
    },
    async confirm(options) {
      const confirmed = await p.confirm(options);
      return p.isCancel(confirmed) ? ONBOARD_CANCELLED : confirmed;
    },
    async password(options) {
      const key = await p.password({
        ...options,
        validate: (value) => options.validate(value ?? ""),
      });
      return p.isCancel(key) ? ONBOARD_CANCELLED : key;
    },
  };
}

function parseOnboardArgs(argv: readonly string[]): OnboardOptions {
  const options: OnboardOptions = { stdin: false, json: false, sandbox: "docker-local" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--provider") {
      const provider = argv[++index];
      if (provider === undefined || provider.startsWith("-")) throw new Error("--provider requires a provider name");
      options.provider = provider;
    } else if (arg === "--stdin") {
      options.stdin = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--sandbox") {
      const sandbox = argv[++index];
      if (sandbox === "docker" || sandbox === "docker-local") options.sandbox = "docker-local";
      else if (sandbox === "microsandbox" || sandbox === "microsandbox-local") options.sandbox = "microsandbox-local";
      else throw new Error("--sandbox requires docker or microsandbox");
    } else {
      throw new Error(`Unknown option for oma onboard: ${arg}`);
    }
  }
  if (options.json && !options.stdin && options.provider === undefined) {
    throw new Error("--json requires --provider and either --stdin or an existing stored credential");
  }
  return options;
}

function onboardingPreflightFailures(report: DoctorReport, sandbox: Sandbox): string[] {
  const required = ["node.version", "models.catalog", "sandbox.runtime", "server.port"];
  if (sandbox === "docker-local") required.push("sandbox.image");
  const failures = report.checks
    .filter((check) => required.includes(check.id) && check.status !== "pass")
    .map((check) => check.summary);
  if (sandbox === "docker-local" && report.checks.find((check) => check.id === "sandbox.image")?.status !== "pass") {
    failures.push(`Pull the cached prerequisite image, then retry: docker pull ${DEFAULT_OMA_SANDBOX_IMAGE}`);
  }
  return [...new Set(failures)];
}

function parseProviderStatus(output: string): string[] {
  const rows = output.trim().split("\n").slice(1).filter(Boolean);
  return rows.map((row) => row.split("\t", 1)[0]!).filter(Boolean);
}

function parseStoredCredential(output: string, provider: string): boolean {
  const row = output.trim().split("\n").slice(1).find((line) => line.startsWith(`${provider}\t`));
  if (row === undefined) throw new Error(`Provider ${provider} was not returned by auth status`);
  return row.split("\t")[1] === "true";
}

async function readOneSecretFromStdin(): Promise<string> {
  let value = "";
  input.setEncoding("utf8");
  for await (const chunk of input) value += chunk;
  value = value.replace(/\r?\n$/, "");
  if (value.includes("\n") || value.includes("\r")) throw new Error("--stdin accepts exactly one API key value");
  return value;
}

function cancelled(runtime: OnboardRuntime, json: boolean, report: DoctorReport): OnboardResult {
  if (json) console.log(JSON.stringify({ schema_version: 1, status: "cancelled" }));
  else runtime.terminal.cancel("Onboarding cancelled before changing OMA credentials.");
  return { code: 130, credential: "not_reached", report };
}

function emitFailure(runtime: OnboardRuntime, json: boolean, message: string): void {
  if (json) console.log(JSON.stringify({ schema_version: 1, status: "failed", error: message }));
  else runtime.terminal.error(message);
}

function emitSuccess(runtime: OnboardRuntime, json: boolean, provider: string, credential: "stored" | "reused", sessionId: string): void {
  if (json) {
    console.log(JSON.stringify({ schema_version: 1, status: "ready", provider, credential, session_id: sessionId }));
    return;
  }
  const verb = credential === "stored" ? "stored securely" : "already stored";
  runtime.terminal.step(`Credential ${verb}.`);
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const result = await runOnboard(process.argv.slice(2), createProcessOnboardRuntime());
  process.exitCode = result.code;
}

if (import.meta.main) void main();
