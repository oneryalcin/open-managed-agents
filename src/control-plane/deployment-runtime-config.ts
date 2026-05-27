import { PiSessionRunner } from "./sessions/pi/runner.ts";
import {
  parseSandboxProviderSelection,
  resolveSandboxProviderFactory,
  type SandboxProviderSelection,
  type SandboxProviderSelectionResolverOptions,
} from "./sessions/pi/sandbox/selection.ts";

export const DEPLOYMENT_RUNTIME_ENV_KEYS = [
  "OMA_SANDBOX_PROVIDER",
  "OMA_SANDBOX_ENV_ALLOWLIST",
  "OMA_SANDBOX_OPERATION_TIMEOUT_MS",
  "OMA_ALLOW_DOCKER_LOCAL",
  "OMA_ALLOW_UNSAFE_HOST_PASSTHROUGH",
  "OMA_UNSAFE_ALLOW_HOST_PASSTHROUGH",
  "OMA_HOST_PASSTHROUGH_WORKSPACE_ROOT",
] as const;

export type DeploymentRuntimeEnvKey =
  (typeof DEPLOYMENT_RUNTIME_ENV_KEYS)[number];

export type DeploymentRuntimeEnv = Partial<
  Record<DeploymentRuntimeEnvKey, string | undefined>
>;

export interface DeploymentRuntimeConfig {
  sandboxProviderSelection?: SandboxProviderSelection;
  sandboxProviderSelectionOptions?: SandboxProviderSelectionResolverOptions;
}

type PiSessionRunnerOptions = NonNullable<
  ConstructorParameters<typeof PiSessionRunner>[0]
>;

export type DeploymentPiSessionRunnerOptions = Omit<
  PiSessionRunnerOptions,
  | "sandboxProviderFactory"
  | "sandboxProviderSelection"
  | "sandboxProviderSelectionOptions"
>;

export function parseDeploymentRuntimeConfigFromEnv(
  env: DeploymentRuntimeEnv,
): DeploymentRuntimeConfig {
  const provider = optionalString(env.OMA_SANDBOX_PROVIDER);
  if (provider === undefined) {
    rejectProviderSpecificEnv(env, "set OMA_SANDBOX_PROVIDER first");
    return validateDeploymentRuntimeConfig({});
  }
  if (provider === "none") {
    rejectProviderSpecificEnv(env, "OMA_SANDBOX_PROVIDER=none");
    return validateDeploymentRuntimeConfig({
      sandboxProviderSelection: { type: "none" },
    });
  }
  if (provider === "docker-local") {
    rejectHostPassthroughEnv(env, "OMA_SANDBOX_PROVIDER=docker-local");
    const selection = parseSandboxProviderSelection({
      type: "docker-local",
      ...envAllowlist(env),
      ...operationTimeoutMs(env),
    });
    return validateDeploymentRuntimeConfig({
      sandboxProviderSelection: selection,
      sandboxProviderSelectionOptions: {
        allowDockerLocal: parseBoolean(env.OMA_ALLOW_DOCKER_LOCAL, {
          defaultValue: false,
          name: "OMA_ALLOW_DOCKER_LOCAL",
        }),
      },
    });
  }
  if (provider === "host-passthrough") {
    rejectDockerEnv(env, "OMA_SANDBOX_PROVIDER=host-passthrough");
    const unsafeAllowHostPassthrough = parseBoolean(
      env.OMA_UNSAFE_ALLOW_HOST_PASSTHROUGH,
      {
        defaultValue: false,
        name: "OMA_UNSAFE_ALLOW_HOST_PASSTHROUGH",
      },
    );
    const selection = parseSandboxProviderSelection({
      type: "host-passthrough",
      unsafeAllowHostPassthrough,
      ...envAllowlist(env),
    });
    return validateDeploymentRuntimeConfig({
      sandboxProviderSelection: selection,
      sandboxProviderSelectionOptions: {
        allowUnsafeHostPassthrough: parseBoolean(
          env.OMA_ALLOW_UNSAFE_HOST_PASSTHROUGH,
          {
            defaultValue: false,
            name: "OMA_ALLOW_UNSAFE_HOST_PASSTHROUGH",
          },
        ),
        hostPassthroughWorkspaceRoot: optionalString(
          env.OMA_HOST_PASSTHROUGH_WORKSPACE_ROOT,
        ),
      },
    });
  }
  throw new Error(`Unsupported OMA_SANDBOX_PROVIDER: ${provider}`);
}

export function validateDeploymentRuntimeConfig(
  config: DeploymentRuntimeConfig,
): DeploymentRuntimeConfig {
  rejectIgnoredResolverOptions(config);
  resolveSandboxProviderFactory(
    config.sandboxProviderSelection,
    config.sandboxProviderSelectionOptions,
  );
  return config;
}

export function createDeploymentPiSessionRunner(
  config: DeploymentRuntimeConfig,
  opts: DeploymentPiSessionRunnerOptions = {},
): PiSessionRunner {
  const rawOpts = opts as Record<string, unknown>;
  if (
    rawOpts.sandboxProviderFactory !== undefined ||
    rawOpts.sandboxProviderSelection !== undefined ||
    rawOpts.sandboxProviderSelectionOptions !== undefined
  ) {
    throw new Error(
      "Deployment runner options cannot override sandbox provider config",
    );
  }
  return new PiSessionRunner({
    ...opts,
    sandboxProviderSelection: config.sandboxProviderSelection,
    sandboxProviderSelectionOptions: config.sandboxProviderSelectionOptions,
  });
}

function optionalString(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value.trim();
}

function parseBoolean(
  value: string | undefined,
  opts: { name: DeploymentRuntimeEnvKey; defaultValue: boolean },
): boolean {
  const parsed = optionalString(value);
  if (parsed === undefined) return opts.defaultValue;
  if (parsed === "true") return true;
  if (parsed === "false") return false;
  throw new Error(`${opts.name} must be "true" or "false"`);
}

function envAllowlist(
  env: DeploymentRuntimeEnv,
): { envAllowlist?: string[] } {
  const raw = optionalString(env.OMA_SANDBOX_ENV_ALLOWLIST);
  if (raw === undefined) return {};
  const values = raw.split(",").map((value) => value.trim());
  if (values.some((value) => value.length === 0)) {
    throw new Error("OMA_SANDBOX_ENV_ALLOWLIST must be comma-separated names");
  }
  return { envAllowlist: values };
}

function operationTimeoutMs(
  env: DeploymentRuntimeEnv,
): { operationTimeoutMs?: number } {
  const raw = optionalString(env.OMA_SANDBOX_OPERATION_TIMEOUT_MS);
  if (raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== raw) {
    throw new Error("OMA_SANDBOX_OPERATION_TIMEOUT_MS must be a positive integer");
  }
  return { operationTimeoutMs: value };
}

function rejectProviderSpecificEnv(
  env: DeploymentRuntimeEnv,
  context: string,
): void {
  rejectDockerEnv(env, context);
  rejectHostPassthroughEnv(env, context);
  if (env.OMA_SANDBOX_ENV_ALLOWLIST !== undefined) {
    throw new Error(`OMA_SANDBOX_ENV_ALLOWLIST requires ${context}`);
  }
}

function rejectIgnoredResolverOptions(config: DeploymentRuntimeConfig): void {
  const selection = config.sandboxProviderSelection;
  const opts = config.sandboxProviderSelectionOptions ?? {};
  if (selection === undefined || selection.type === "none") {
    rejectDefinedOption(opts.allowDockerLocal, "allowDockerLocal", "no provider");
    rejectDefinedOption(
      opts.allowUnsafeHostPassthrough,
      "allowUnsafeHostPassthrough",
      "no provider",
    );
    rejectDefinedOption(
      opts.hostPassthroughWorkspaceRoot,
      "hostPassthroughWorkspaceRoot",
      "no provider",
    );
    return;
  }
  if (selection.type === "docker-local") {
    rejectDefinedOption(
      opts.allowUnsafeHostPassthrough,
      "allowUnsafeHostPassthrough",
      "docker-local",
    );
    rejectDefinedOption(
      opts.hostPassthroughWorkspaceRoot,
      "hostPassthroughWorkspaceRoot",
      "docker-local",
    );
    return;
  }
  if (selection.type === "host-passthrough") {
    rejectDefinedOption(opts.allowDockerLocal, "allowDockerLocal", "host-passthrough");
  }
}

function rejectDefinedOption(
  value: unknown,
  optionName: string,
  context: string,
): void {
  if (value !== undefined) {
    throw new Error(`${optionName} is ignored by ${context}`);
  }
}

function rejectDockerEnv(env: DeploymentRuntimeEnv, context: string): void {
  if (env.OMA_ALLOW_DOCKER_LOCAL !== undefined) {
    throw new Error(`OMA_ALLOW_DOCKER_LOCAL is ignored by ${context}`);
  }
  if (env.OMA_SANDBOX_OPERATION_TIMEOUT_MS !== undefined) {
    throw new Error(`OMA_SANDBOX_OPERATION_TIMEOUT_MS is ignored by ${context}`);
  }
}

function rejectHostPassthroughEnv(
  env: DeploymentRuntimeEnv,
  context: string,
): void {
  if (env.OMA_ALLOW_UNSAFE_HOST_PASSTHROUGH !== undefined) {
    throw new Error(
      `OMA_ALLOW_UNSAFE_HOST_PASSTHROUGH is ignored by ${context}`,
    );
  }
  if (env.OMA_UNSAFE_ALLOW_HOST_PASSTHROUGH !== undefined) {
    throw new Error(
      `OMA_UNSAFE_ALLOW_HOST_PASSTHROUGH is ignored by ${context}`,
    );
  }
  if (env.OMA_HOST_PASSTHROUGH_WORKSPACE_ROOT !== undefined) {
    throw new Error(
      `OMA_HOST_PASSTHROUGH_WORKSPACE_ROOT is ignored by ${context}`,
    );
  }
}
