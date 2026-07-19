import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_NETWORKING_PRESETS,
  environmentNetworkingPresetCatalog,
  validateEnvironmentNetworkingHosts,
} from "../presets.ts";

describe("environment networking presets", () => {
  it("keeps the reviewed catalog versioned, normalized, and duplicate-free", () => {
    expect(ENVIRONMENT_NETWORKING_PRESETS.map((preset) => preset.id)).toEqual([
      "offline-v1",
      "npm-pypi-v1",
      "github-packages-v1",
    ]);
    expect(ENVIRONMENT_NETWORKING_PRESETS[0]?.networking.allowed_hosts).toEqual([]);
    for (const preset of ENVIRONMENT_NETWORKING_PRESETS) {
      expect(preset.version).toBe(1);
      expect(new Set(preset.networking.allowed_hosts).size).toBe(
        preset.networking.allowed_hosts.length,
      );
      expect(preset.networking.allowed_hosts).toEqual(
        preset.networking.allowed_hosts.map((host) => host.toLowerCase()),
      );
    }
  });

  it("returns deployment capability separately from immutable policy", () => {
    const catalog = environmentNetworkingPresetCatalog({
      provider: "docker-local",
      egress_supported: true,
      reason: null,
    });
    expect(catalog.deployment.egress_supported).toBe(true);
    expect(catalog.presets[0]?.networking.allowed_hosts).toEqual([]);
    expect(catalog.custom).toEqual({
      https_only: true,
      wildcard_matches_bare_domain: false,
    });
  });

  it("canonicalizes custom hosts with the runtime parser", () => {
    expect(
      validateEnvironmentNetworkingHosts({
        allowed_hosts: ["API.Example.com", "*.Example.org"],
      }),
    ).toEqual({ allowed_hosts: ["api.example.com", "*.example.org"] });
    expect(() =>
      validateEnvironmentNetworkingHosts({
        allowed_hosts: ["example.com", "EXAMPLE.com"],
      }),
    ).toThrow("duplicate entry example.com");
    expect(() =>
      validateEnvironmentNetworkingHosts({
        allowed_hosts: ["example.com"],
        unrestricted: true,
      }),
    ).toThrow("contain only `allowed_hosts`");
  });
});
