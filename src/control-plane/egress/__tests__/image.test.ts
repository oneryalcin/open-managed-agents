import { describe, expect, it } from "vitest";
import {
  DEFAULT_OMA_EGRESS_SIDECAR_IMAGE,
  resolveOmaUpEgressEnvironment,
} from "../image.ts";

describe("oma up egress image resolution", () => {
  it("enables the public digest-pinned sidecar for Docker by default", () => {
    expect(resolveOmaUpEgressEnvironment({ KEEP:"yes" }, "docker-local")).toMatchObject({
      KEEP:"yes",
      OMA_ENABLE_EGRESS:"true",
      OMA_EGRESS_SIDECAR_IMAGE:DEFAULT_OMA_EGRESS_SIDECAR_IMAGE,
    });
    expect(DEFAULT_OMA_EGRESS_SIDECAR_IMAGE).toMatch(/^ghcr\.io\/oneryalcin\/open-managed-agents-sandbox@sha256:[a-f0-9]{64}$/);
  });

  it("supports an explicit disable without inheriting an image", () => {
    expect(resolveOmaUpEgressEnvironment({ OMA_ENABLE_EGRESS:"false" }, "docker-local"))
      .toEqual({ OMA_ENABLE_EGRESS:"false" });
  });

  it("accepts a complete advanced override and rejects partial combinations", () => {
    expect(resolveOmaUpEgressEnvironment({
      OMA_ENABLE_EGRESS:"true",
      OMA_EGRESS_SIDECAR_IMAGE:"example/sidecar@sha256:abc",
      OMA_EGRESS_SIDECAR_REPO_MOUNT:" /repo ",
    }, "docker-local")).toEqual({
      OMA_ENABLE_EGRESS:"true",
      OMA_EGRESS_SIDECAR_IMAGE:"example/sidecar@sha256:abc",
      OMA_EGRESS_SIDECAR_REPO_MOUNT:"/repo",
    });
    expect(() => resolveOmaUpEgressEnvironment({ OMA_ENABLE_EGRESS:"true" }, "docker-local"))
      .toThrow("requires OMA_ENABLE_EGRESS=true and OMA_EGRESS_SIDECAR_IMAGE together");
    expect(() => resolveOmaUpEgressEnvironment({ OMA_EGRESS_SIDECAR_IMAGE:"example/image" }, "docker-local"))
      .toThrow("requires OMA_ENABLE_EGRESS=true and OMA_EGRESS_SIDECAR_IMAGE together");
  });

  it("keeps microsandbox egress unsupported and rejects ambient overrides", () => {
    expect(resolveOmaUpEgressEnvironment({ KEEP:"yes" }, "microsandbox-local")).toEqual({ KEEP:"yes" });
    expect(() => resolveOmaUpEgressEnvironment({ OMA_ENABLE_EGRESS:"true" }, "microsandbox-local"))
      .toThrow("require `oma up --sandbox docker`");
  });
});
