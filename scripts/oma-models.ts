// Operator CLI for Pi model/provider discovery and model credential storage
// (plan 0139 D6). This intentionally reuses the same deployment parser,
// catalog factory, and atomic AuthStorage backend as the control plane.
import { stdin as input, stderr as errorOut } from "node:process";
import { pathToFileURL } from "node:url";
import {
  parseModelDeploymentConfigFromEnv,
  validateModelDeploymentConfigAgainstCatalog,
  type ModelDeploymentEnv,
} from "../src/control-plane/models/deployment-config.ts";
import { createOmaAuthStorageBackend } from "../src/control-plane/models/auth-storage-backend.ts";
import { createPiModelCatalog, type PiModelCatalog } from "../src/control-plane/models/catalog.ts";

const USAGE = `Usage: npx tsx scripts/oma-models.ts <command> [args]

Commands:
  providers-status                         Show enabled model providers
  models-list [--provider name] [--available]
                                           List enabled models
  models-validate [--file path]            Validate Pi models.json and deployment policy
  auth-set <provider> [--stdin]            Store an API key for an enabled provider
  auth-remove <provider>                   Remove a stored provider API key (idempotent)
  auth-status [provider]                   Show credential readiness without secrets
`;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Runtime {
  env: ModelDeploymentEnv & Record<string, string | undefined>;
  readStdin?: () => Promise<string>;
  promptSecret?: (message: string) => Promise<string>;
}

export async function runModelsCli(
  argv: readonly string[],
  runtime: Runtime,
): Promise<CliResult> {
  const [command, ...args] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    return { code: command === undefined ? 1 : 0, stdout: USAGE, stderr: "" };
  }
  try {
    switch (command) {
      case "providers-status":
        return ok(providersStatus(loadCatalog(runtime.env)));
      case "models-list": {
        const options = parseModelsListArgs(args);
        return ok(modelsList(loadCatalog(runtime.env), options));
      }
      case "models-validate":
        return ok(modelsValidate(runtime.env, parseModelsValidateArgs(args)));
      case "auth-set":
        return ok(await authSet(runtime, args));
      case "auth-remove":
        return ok(authRemove(runtime.env, args));
      case "auth-status":
        assertAuthStatusArgs(args);
        return ok(authStatus(loadCatalog(runtime.env), args));
      default:
        return fail(`Unknown command: ${command}\n\n${USAGE}`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function loadCatalog(
  env: ModelDeploymentEnv & Record<string, string | undefined>,
  overrides: { modelsPath?: string } = {},
): PiModelCatalog {
  const deployment = parseModelDeploymentConfigFromEnv(env);
  const config = {
    ...deployment,
    ...(overrides.modelsPath === undefined ? {} : { modelsPath: overrides.modelsPath }),
  };
  const catalog = createPiModelCatalog({
    allowedProviders: config.allowedProviders,
    defaultModel: config.defaultModel,
    authPath: config.authPath,
    modelsPath: config.modelsPath,
    allowModelAuthCommands: config.allowModelAuthCommands,
    authBackend: createOmaAuthStorageBackend(config.authPath),
  });
  validateModelDeploymentConfigAgainstCatalog(config, {
    hasProvider: (provider) => catalog.allowedProviders.has(provider),
    hasModel: (model) => catalog.resolve(model) !== undefined,
  });
  return catalog;
}

function providersStatus(catalog: PiModelCatalog): string {
  const lines = ["provider\tname\tready_models\ttotal_models\tdefault"];
  for (const provider of [...catalog.allowedProviders].sort()) {
    const models = catalog.list({ provider });
    const available = models.filter((model) => catalog.hasConfiguredAuth(model));
    const isDefault = provider === catalog.defaultModel.provider;
    const displayName = catalog.modelRegistry.getProviderDisplayName(provider);
    lines.push(
      [
        provider,
        displayName,
        String(available.length),
        String(models.length),
        isDefault ? "true" : "false",
      ].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

function modelsList(
  catalog: PiModelCatalog,
  options: { provider?: string; availableOnly: boolean },
): string {
  if (options.provider !== undefined && !catalog.allowedProviders.has(options.provider)) {
    throw new Error(`Model provider ${options.provider} is not enabled on this deployment`);
  }
  const models = catalog.list({
    provider: options.provider,
    availableOnly: options.availableOnly,
  }).sort((a, b) =>
    a.provider.localeCompare(b.provider) ||
    a.id.localeCompare(b.id)
  );
  const lines = ["provider\tid\tname\tapi\tcredentials_configured\tdefault"];
  for (const model of models) {
    const isDefault =
      model.provider === catalog.defaultModel.provider &&
      model.id === catalog.defaultModel.id;
    lines.push(
      [
        model.provider,
        model.id,
        model.name,
        model.api,
        catalog.hasConfiguredAuth(model) ? "true" : "false",
        isDefault ? "true" : "false",
      ].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

function modelsValidate(
  env: ModelDeploymentEnv & Record<string, string | undefined>,
  options: { file?: string },
): string {
  const catalog = loadCatalog(env, options.file === undefined ? {} : { modelsPath: options.file });
  const warnings = catalog.securityReport.warnings.map((warning) => `Warning: ${warning}`);
  return [
    ...warnings,
    `Model configuration is valid.`,
    `Enabled providers: ${[...catalog.allowedProviders].sort().join(", ")}`,
    `Default model: ${catalog.defaultModel.provider}/${catalog.defaultModel.id}`,
    "",
  ].join("\n");
}

async function authSet(runtime: Runtime, args: string[]): Promise<string> {
  const parsed = parseAuthSetArgs(args);
  const catalog = loadCatalog(runtime.env);
  assertEnabledProvider(catalog, parsed.provider);
  const key = parsed.stdin
    ? await (runtime.readStdin ?? readAllStdin)()
    : await (runtime.promptSecret ?? promptSecret)(`API key for ${parsed.provider}: `);
  const trimmed = key.trim();
  if (trimmed === "") throw new Error("API key must not be empty");
  catalog.authStorage.set(parsed.provider, { type: "api_key", key: trimmed });
  return (
    `Stored API key for ${parsed.provider}.\n` +
    `The key was not printed. Restart \`oma up\` for a running appliance to observe this change.\n`
  );
}

function authRemove(
  env: ModelDeploymentEnv & Record<string, string | undefined>,
  args: string[],
): string {
  if (args.length !== 1) throw new Error("Usage: oma auth remove <provider>");
  const [provider] = args;
  assertProviderName(provider);
  const catalog = loadCatalog(env);
  catalog.authStorage.remove(provider);
  return `Removed stored API key for ${provider} if one existed. Restart \`oma up\` for a running appliance to observe this change.\n`;
}

function authStatus(catalog: PiModelCatalog, args: string[]): string {
  const providers = args.length === 1 ? [args[0]!] : [...catalog.allowedProviders].sort();
  const lines = ["provider\tstored\tready_models\ttotal_models"];
  for (const provider of providers) {
    assertProviderName(provider);
    assertEnabledProvider(catalog, provider);
    const models = catalog.list({ provider });
    const ready = models.filter((model) => catalog.hasConfiguredAuth(model));
    lines.push([
      provider,
      catalog.authStorage.has(provider) ? "true" : "false",
      String(ready.length),
      String(models.length),
    ].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function assertAuthStatusArgs(args: string[]): void {
  if (args.length > 1 || args[0]?.startsWith("--")) {
    throw new Error("Usage: oma auth status [provider]");
  }
}

function parseModelsListArgs(args: string[]): { provider?: string; availableOnly: boolean } {
  const options: { provider?: string; availableOnly: boolean } = { availableOnly: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--provider") {
      const provider = requiredOption(args, ++index, arg);
      assertProviderName(provider);
      options.provider = provider;
    } else if (arg === "--available") {
      options.availableOnly = true;
    } else {
      throw new Error(`Unknown option for oma models list: ${arg}\nRun \`oma help models list\` for usage.`);
    }
  }
  return options;
}

function parseModelsValidateArgs(args: string[]): { file?: string } {
  const options: { file?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--file") {
      options.file = requiredOption(args, ++index, arg);
    } else {
      throw new Error(`Unknown option for oma models validate: ${arg}\nRun \`oma help models validate\` for usage.`);
    }
  }
  return options;
}

function parseAuthSetArgs(args: string[]): { provider: string; stdin: boolean } {
  const [provider, ...rest] = args;
  if (!provider) throw new Error("Usage: oma auth set <provider> [--stdin]");
  assertProviderName(provider);
  let stdin = false;
  for (const arg of rest) {
    if (arg === "--stdin") {
      stdin = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option for oma auth set: ${arg}\nRun \`oma help auth set\` for usage.`);
    } else {
      throw new Error("oma auth set does not accept API keys as command-line arguments. Use --stdin or the hidden prompt.");
    }
  }
  return { provider, stdin };
}

function assertEnabledProvider(catalog: PiModelCatalog, provider: string): void {
  if (!catalog.allowedProviders.has(provider)) {
    throw new Error(`Model provider ${provider} is not enabled on this deployment`);
  }
}

function assertProviderName(provider: string): void {
  if (provider === "" || provider.trim() !== provider) {
    throw new Error(`Invalid provider name: ${provider}`);
  }
}

function requiredOption(args: string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function ok(stdout: string): CliResult {
  return { code: 0, stdout, stderr: "" };
}

function fail(message: string): CliResult {
  return { code: 2, stdout: "", stderr: `${message}\n` };
}

async function readAllStdin(): Promise<string> {
  let out = "";
  input.setEncoding("utf8");
  for await (const chunk of input) out += chunk;
  if (out.endsWith("\n")) out = out.slice(0, -1);
  if (out.endsWith("\r")) out = out.slice(0, -1);
  if (out.includes("\n") || out.includes("\r")) {
    throw new Error("--stdin accepts exactly one API key value");
  }
  return out;
}

async function promptSecret(message: string): Promise<string> {
  if (!input.isTTY) throw new Error("Cannot prompt for an API key on non-interactive stdin; use --stdin");
  errorOut.write(message);
  return await new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const wasRaw = input.isRaw;
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\n" || char === "\r") {
          cleanup();
          errorOut.write("\n");
          resolve(chunks.join(""));
          return;
        }
        if (char === "\u0003") {
          cleanup();
          errorOut.write("\n");
          reject(new Error("Cancelled"));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          chunks.pop();
          continue;
        }
        chunks.push(char);
      }
    };
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
    };
    input.resume();
    input.setRawMode(true);
    input.on("data", onData);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = await runModelsCli(process.argv.slice(2), { env: process.env });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
