import { invalidRequest } from "../errors.ts";
import { canonicalizeHostedAllowedHosts, EgressPolicyError } from "./policy.ts";

export interface EnvironmentNetworkingPreset {
  id: string;
  version: number;
  name: string;
  description: string;
  networking: { type: "limited"; allowed_hosts: string[] };
}

export interface EnvironmentNetworkingDeploymentCapability {
  provider: string | null;
  egress_supported: boolean;
  reason: string | null;
}

const DEFINITIONS = [
  {
    id: "offline-v1",
    version: 1,
    name: "Offline",
    description: "No network access. This is the default.",
    allowedHosts: [],
  },
  {
    id: "npm-pypi-v1",
    version: 1,
    name: "npm + PyPI",
    description: "Install packages from the npm and Python package registries.",
    allowedHosts: [
      "registry.npmjs.org",
      "pypi.org",
      "files.pythonhosted.org",
    ],
  },
  {
    id: "github-packages-v1",
    version: 1,
    name: "GitHub + package registries",
    description: "Clone and download from GitHub, npm, and PyPI.",
    allowedHosts: [
      "registry.npmjs.org",
      "pypi.org",
      "files.pythonhosted.org",
      "github.com",
      "api.github.com",
      "codeload.github.com",
      "*.githubusercontent.com",
    ],
  },
] as const;

export const ENVIRONMENT_NETWORKING_PRESETS: readonly EnvironmentNetworkingPreset[] =
  Object.freeze(
    DEFINITIONS.map((definition) =>
      Object.freeze({
        id: definition.id,
        version: definition.version,
        name: definition.name,
        description: definition.description,
        networking: Object.freeze({
          type: "limited" as const,
          allowed_hosts: Object.freeze(
            canonicalizeHostedAllowedHosts([...definition.allowedHosts]),
          ) as unknown as string[],
        }),
      }),
    ),
  );

export function environmentNetworkingPresetCatalog(
  deployment: EnvironmentNetworkingDeploymentCapability,
) {
  return {
    type: "environment_networking_presets" as const,
    deployment,
    presets: ENVIRONMENT_NETWORKING_PRESETS,
    custom: {
      https_only: true,
      wildcard_matches_bare_domain: false,
    },
  };
}

export function validateEnvironmentNetworkingHosts(input: unknown): {
  allowed_hosts: string[];
} {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== "allowed_hosts")
  ) {
    throw invalidRequest("Request body must contain only `allowed_hosts`");
  }
  try {
    return {
      allowed_hosts: canonicalizeHostedAllowedHosts(
        (input as Record<string, unknown>)["allowed_hosts"],
      ),
    };
  } catch (error) {
    if (error instanceof EgressPolicyError) {
      throw invalidRequest(`Invalid environment networking config: ${error.message}`);
    }
    throw error;
  }
}
