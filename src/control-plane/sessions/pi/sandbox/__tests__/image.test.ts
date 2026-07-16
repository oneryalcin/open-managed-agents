import { describe, expect, it } from "vitest";
import { DEFAULT_DOCKER_SANDBOX_IMAGE } from "../docker.ts";
import { DEFAULT_OMA_SANDBOX_IMAGE } from "../image.ts";
import { DEFAULT_MICROSANDBOX_IMAGE } from "../microsandbox.ts";

describe("OMA sandbox image defaults", () => {
  it("pins Docker and microsandbox to the same immutable GHCR digest", () => {
    expect(DEFAULT_OMA_SANDBOX_IMAGE).toMatch(
      /^ghcr\.io\/oneryalcin\/open-managed-agents-sandbox@sha256:[0-9a-f]{64}$/,
    );
    expect(DEFAULT_DOCKER_SANDBOX_IMAGE).toBe(DEFAULT_OMA_SANDBOX_IMAGE);
    expect(DEFAULT_MICROSANDBOX_IMAGE).toBe(DEFAULT_OMA_SANDBOX_IMAGE);
  });
});
