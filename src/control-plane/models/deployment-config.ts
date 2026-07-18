import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_MODEL_PROVIDER = "anthropic";
export const DEFAULT_MODEL_ID = "claude-sonnet-5";

export const MODEL_DEPLOYMENT_ENV_KEYS = [
  "OMA_HOME",
  "OMA_MODEL_PROVIDERS",
  "OMA_DEFAULT_MODEL_PROVIDER",
  "OMA_DEFAULT_MODEL",
  "OMA_PI_AUTH_FILE",
  "OMA_PI_MODELS_FILE",
  "OMA_ALLOW_MODEL_AUTH_COMMANDS",
] as const;

export type ModelDeploymentEnvKey =
  (typeof MODEL_DEPLOYMENT_ENV_KEYS)[number];

export type ModelDeploymentEnv = Partial<
  Record<ModelDeploymentEnvKey, string | undefined>
>;

export interface DeploymentModelRef {
  provider: string;
  id: string;
}

export interface ModelDeploymentConfig {
  allowedProviders: readonly string[];
  defaultModel: DeploymentModelRef;
  authPath: string;
  modelsPath: string;
  allowModelAuthCommands: boolean;
}

export interface ModelDeploymentCatalog {
  hasProvider(provider: string): boolean;
  hasModel(model: DeploymentModelRef): boolean;
}

export function parseModelDeploymentConfigFromEnv(
  env: ModelDeploymentEnv,
  opts: { home?: string } = {},
): ModelDeploymentConfig {
  const allowedProviders = parseAllowedProviders(env.OMA_MODEL_PROVIDERS);
  const defaultModel = parseDefaultModel(env, allowedProviders);
  const home = optionalEnvString(env.OMA_HOME, "OMA_HOME") ?? opts.home ?? join(homedir(), ".oma");
  const authPath =
    optionalEnvString(env.OMA_PI_AUTH_FILE, "OMA_PI_AUTH_FILE") ??
    join(home, "pi", "auth.json");
  const modelsPath =
    optionalEnvString(env.OMA_PI_MODELS_FILE, "OMA_PI_MODELS_FILE") ??
    join(home, "pi", "models.json");
  return {
    allowedProviders,
    defaultModel,
    authPath: resolve(authPath),
    modelsPath: resolve(modelsPath),
    allowModelAuthCommands: parseBoolean(env.OMA_ALLOW_MODEL_AUTH_COMMANDS, {
      defaultValue: false,
      name: "OMA_ALLOW_MODEL_AUTH_COMMANDS",
    }),
  };
}

export function validateModelDeploymentConfigAgainstCatalog(
  config: ModelDeploymentConfig,
  catalog: ModelDeploymentCatalog,
): ModelDeploymentConfig {
  for (const provider of config.allowedProviders) {
    if (!catalog.hasProvider(provider)) {
      throw new Error(`Model provider ${provider} is not available on this deployment`);
    }
  }
  if (!catalog.hasModel(config.defaultModel)) {
    throw new Error(
      `Default model ${config.defaultModel.provider}/${config.defaultModel.id} is not available on this deployment`,
    );
  }
  return config;
}

function parseAllowedProviders(raw: string | undefined): readonly string[] {
  const value = optionalEnvString(raw, "OMA_MODEL_PROVIDERS");
  if (value === undefined) return [DEFAULT_MODEL_PROVIDER];
  const providers = value.split(",").map((entry) => entry.trim());
  if (providers.some((provider) => provider.length === 0)) {
    throw new Error("OMA_MODEL_PROVIDERS must be comma-separated provider names");
  }
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider)) {
      throw new Error(`Duplicate model provider in OMA_MODEL_PROVIDERS: ${provider}`);
    }
    seen.add(provider);
  }
  return providers;
}

function parseDefaultModel(
  env: ModelDeploymentEnv,
  allowedProviders: readonly string[],
): DeploymentModelRef {
  const provider = optionalEnvString(
    env.OMA_DEFAULT_MODEL_PROVIDER,
    "OMA_DEFAULT_MODEL_PROVIDER",
  );
  const id = optionalEnvString(env.OMA_DEFAULT_MODEL, "OMA_DEFAULT_MODEL");
  if (provider === undefined && id === undefined) {
    return { provider: DEFAULT_MODEL_PROVIDER, id: DEFAULT_MODEL_ID };
  }
  if (provider === undefined || id === undefined) {
    throw new Error(
      "OMA_DEFAULT_MODEL_PROVIDER and OMA_DEFAULT_MODEL must be set together",
    );
  }
  if (!allowedProviders.includes(provider)) {
    throw new Error(
      `OMA_DEFAULT_MODEL_PROVIDER ${provider} must be listed in OMA_MODEL_PROVIDERS`,
    );
  }
  return { provider, id };
}

function optionalEnvString(
  value: string | undefined,
  name: ModelDeploymentEnvKey,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") throw new Error(`${name} must not be empty`);
  return trimmed;
}

function parseBoolean(
  value: string | undefined,
  opts: { name: ModelDeploymentEnvKey; defaultValue: boolean },
): boolean {
  const parsed = optionalEnvString(value, opts.name);
  if (parsed === undefined) return opts.defaultValue;
  if (parsed === "true") return true;
  if (parsed === "false") return false;
  throw new Error(`${opts.name} must be "true" or "false"`);
}
