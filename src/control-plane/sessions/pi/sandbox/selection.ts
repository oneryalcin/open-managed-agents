import {
  createHostPassthroughSandboxProvider,
  type SandboxProviderFactory,
} from "./provider.ts";
import {
  createDockerSandboxProviderFactory,
  type DockerSandboxEgressFactoryOptions,
} from "./docker.ts";
import { createMicrosandboxSandboxProviderFactory } from "./microsandbox.ts";

export type SandboxProviderSelection =
  | { type: "none" }
  | {
      type: "host-passthrough";
      unsafeAllowHostPassthrough: true;
      envAllowlist?: string[];
    }
  | {
      type: "docker-local";
      envAllowlist?: string[];
      operationTimeoutMs?: number;
      reapStaleContainersOlderThanMs?: number;
    }
  | {
      type: "microsandbox-local";
      operationTimeoutMs?: number;
      reapStaleSandboxesOlderThanMs?: number;
    };

export interface SandboxProviderSelectionResolverOptions {
  allowUnsafeHostPassthrough?: boolean;
  allowDockerLocal?: boolean;
  allowMicrosandboxLocal?: boolean;
  hostPassthroughWorkspaceRoot?: string;
  /**
   * Per-session credentialed egress (plan 0117e-3). docker-local only:
   * microsandbox keeps its no-secret posture and host-passthrough has no
   * network boundary to wire — passing egress with either is an error, never
   * a silent ignore.
   */
  egress?: DockerSandboxEgressFactoryOptions;
  /** 0121 C2 telemetry: startup sweeps reaped N stale sandboxes/containers. */
  onReaped?: (count: number) => void;
}

export function parseSandboxProviderSelection(
  input: unknown,
): SandboxProviderSelection {
  const obj = objectInput(input, "sandbox provider selection");
  const type = stringField(obj, "type");
  switch (type) {
    case "none":
      rejectUnknownFields(obj, ["type"]);
      return { type };
    case "host-passthrough": {
      rejectUnknownFields(obj, [
        "type",
        "unsafeAllowHostPassthrough",
        "envAllowlist",
      ]);
      const unsafeAllowHostPassthrough =
        obj.unsafeAllowHostPassthrough === true;
      if (!unsafeAllowHostPassthrough) {
        throw new Error(
          "`unsafeAllowHostPassthrough` must be true for host-passthrough",
        );
      }
      return {
        type,
        unsafeAllowHostPassthrough,
        ...optionalEnvAllowlist(obj),
      };
    }
    case "docker-local": {
      rejectUnknownFields(obj, [
        "type",
        "envAllowlist",
        "operationTimeoutMs",
        "reapStaleContainersOlderThanMs",
        "unsafeAllowHostPassthrough",
      ]);
      if (obj.unsafeAllowHostPassthrough !== undefined) {
        throw new Error(
          "`unsafeAllowHostPassthrough` is only valid for host-passthrough",
        );
      }
      return {
        type,
        ...optionalEnvAllowlist(obj),
        ...optionalOperationTimeoutMs(obj),
        ...optionalReapStaleContainersOlderThanMs(obj),
      };
    }
    case "microsandbox-local": {
      rejectUnknownFields(obj, [
        "type",
        "operationTimeoutMs",
        "reapStaleSandboxesOlderThanMs",
      ]);
      return {
        type,
        ...optionalOperationTimeoutMs(obj),
        ...optionalReapStaleSandboxesOlderThanMs(obj),
      };
    }
    default:
      throw new Error(`Unsupported sandbox provider type: ${type}`);
  }
}

export function resolveSandboxProviderFactory(
  selection: SandboxProviderSelection | undefined,
  opts: SandboxProviderSelectionResolverOptions = {},
): SandboxProviderFactory | undefined {
  if (selection === undefined || selection.type === "none") {
    rejectEgressOption(opts, selection?.type ?? "none");
    return undefined;
  }
  if (selection.type === "host-passthrough") {
    rejectEgressOption(opts, selection.type);
    if (selection.unsafeAllowHostPassthrough !== true) {
      throw new Error(
        "`unsafeAllowHostPassthrough` must be true for host-passthrough",
      );
    }
    if (opts.allowUnsafeHostPassthrough !== true) {
      throw new Error(
        "Host passthrough provider is disabled by deployment configuration",
      );
    }
    if (!opts.hostPassthroughWorkspaceRoot) {
      throw new Error(
        "Host passthrough provider requires a deployment workspace root",
      );
    }
    const workspaceRoot = opts.hostPassthroughWorkspaceRoot;
    return async () =>
      createHostPassthroughSandboxProvider({
        workspaceRoot,
        unsafeAllowHostPassthrough: selection.unsafeAllowHostPassthrough,
        envAllowlist: selection.envAllowlist,
      });
  }
  if (selection.type === "docker-local") {
    if (opts.allowDockerLocal !== true) {
      throw new Error(
        "Docker-local sandbox provider is disabled by deployment configuration",
      );
    }
    return createDockerSandboxProviderFactory({
      envAllowlist: selection.envAllowlist,
      operationTimeoutMs: selection.operationTimeoutMs,
      reapStaleContainersOlderThanMs:
        selection.reapStaleContainersOlderThanMs,
      ...(opts.egress === undefined ? {} : { egress: opts.egress }),
      ...(opts.onReaped === undefined ? {} : { onReaped: opts.onReaped }),
    });
  }
  if (selection.type === "microsandbox-local") {
    rejectEgressOption(opts, selection.type);
    if (opts.allowMicrosandboxLocal !== true) {
      throw new Error(
        "Microsandbox-local sandbox provider is disabled by deployment configuration",
      );
    }
    return createMicrosandboxSandboxProviderFactory({
      operationTimeoutMs: selection.operationTimeoutMs,
      reapStaleSandboxesOlderThanMs:
        selection.reapStaleSandboxesOlderThanMs,
      ...(opts.onReaped === undefined ? {} : { onReaped: opts.onReaped }),
    });
  }
  const _exhaustive: never = selection;
  throw new Error(`Unsupported sandbox provider type: ${String(_exhaustive)}`);
}

function rejectEgressOption(
  opts: SandboxProviderSelectionResolverOptions,
  providerType: string,
): void {
  if (opts.egress !== undefined) {
    throw new Error(
      `egress is only supported by docker-local, not ${providerType}`,
    );
  }
}

function objectInput(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return input as Record<string, unknown>;
}

function stringField(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`\`${field}\` must be a non-empty string`);
}

function optionalEnvAllowlist(
  obj: Record<string, unknown>,
): { envAllowlist?: string[] } {
  if (obj.envAllowlist === undefined) return {};
  if (!Array.isArray(obj.envAllowlist)) {
    throw new Error("`envAllowlist` must be an array of strings");
  }
  const envAllowlist = obj.envAllowlist.map((value) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("`envAllowlist` must be an array of non-empty strings");
    }
    return value;
  });
  return { envAllowlist };
}

function optionalOperationTimeoutMs(
  obj: Record<string, unknown>,
): { operationTimeoutMs?: number } {
  return optionalPositiveIntegerField(obj, "operationTimeoutMs");
}

function optionalReapStaleContainersOlderThanMs(
  obj: Record<string, unknown>,
): { reapStaleContainersOlderThanMs?: number } {
  return optionalPositiveIntegerField(obj, "reapStaleContainersOlderThanMs");
}

function optionalReapStaleSandboxesOlderThanMs(
  obj: Record<string, unknown>,
): { reapStaleSandboxesOlderThanMs?: number } {
  return optionalPositiveIntegerField(obj, "reapStaleSandboxesOlderThanMs");
}

function optionalPositiveIntegerField<T extends string>(
  obj: Record<string, unknown>,
  field: T,
): { [K in T]?: number } {
  if (obj[field] === undefined) return {};
  const value = obj[field];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(`\`${field}\` must be a positive integer`);
  }
  return { [field]: value } as { [K in T]?: number };
}

function rejectUnknownFields(
  obj: Record<string, unknown>,
  allowedFields: string[],
): void {
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(obj)) {
    if (allowed.has(field)) continue;
    throw new Error(`Unsupported sandbox provider field: ${field}`);
  }
}
