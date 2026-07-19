/** Dedicated, public, multi-platform OMA egress sidecar (plan 0141). */
export const DEFAULT_OMA_EGRESS_SIDECAR_IMAGE =
  "ghcr.io/oneryalcin/open-managed-agents-sandbox@sha256:5a830df1af072c0f03bc6fe05761f8a7f120dc7eec5b6ec921a10ead59963e30";

const KEYS = [
  "OMA_ENABLE_EGRESS",
  "OMA_EGRESS_SIDECAR_IMAGE",
  "OMA_EGRESS_SIDECAR_REPO_MOUNT",
] as const;

type EgressEnvKey = (typeof KEYS)[number];
type MutableEnvironment = Record<string, string | undefined>;

/**
 * Resolve the `oma up` egress environment without silently completing a
 * partial operator override from OMA defaults.
 */
export function resolveOmaUpEgressEnvironment(
  input: MutableEnvironment,
  sandbox: "docker-local" | "microsandbox-local",
): MutableEnvironment {
  const output = { ...input };
  for (const key of KEYS) delete output[key];

  const enabled = optional(input.OMA_ENABLE_EGRESS);
  const image = optional(input.OMA_EGRESS_SIDECAR_IMAGE);
  const repoMount = optional(input.OMA_EGRESS_SIDECAR_REPO_MOUNT);
  const hasAnyOverride = enabled !== undefined || image !== undefined || repoMount !== undefined;

  if (sandbox !== "docker-local") {
    if (hasAnyOverride) {
      throw new Error("OMA egress overrides require `oma up --sandbox docker`");
    }
    return output;
  }

  if (!hasAnyOverride) {
    output.OMA_ENABLE_EGRESS = "true";
    output.OMA_EGRESS_SIDECAR_IMAGE = DEFAULT_OMA_EGRESS_SIDECAR_IMAGE;
    return output;
  }

  if (enabled === "false" && image === undefined && repoMount === undefined) {
    output.OMA_ENABLE_EGRESS = "false";
    return output;
  }
  if (enabled !== "true" || image === undefined) {
    throw new Error(
      "Custom egress configuration requires OMA_ENABLE_EGRESS=true and OMA_EGRESS_SIDECAR_IMAGE together; use OMA_ENABLE_EGRESS=false alone to disable it",
    );
  }
  output.OMA_ENABLE_EGRESS = "true";
  output.OMA_EGRESS_SIDECAR_IMAGE = image;
  if (repoMount !== undefined) output.OMA_EGRESS_SIDECAR_REPO_MOUNT = repoMount;
  return output;
}

function optional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value.trim();
}
