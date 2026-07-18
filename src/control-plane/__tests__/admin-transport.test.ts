import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeploymentControlPlane, isLoopbackHost } from "../app.ts";
import { generateAdminKey } from "../admin/auth.ts";

// 0120 §3.2 (review finding H2, extended post-implementation-review to all
// API keys): a plaintext non-loopback bind sends every credential — the
// admin key and each workspace x-api-key — in cleartext, so api-key mode on
// such a bind must refuse to boot unless the operator explicitly asserts
// TLS or opts into the exposure. The production bug locked in: Docker's
// OMA_HOST=0.0.0.0 silently serving credentials over plain HTTP.

const ADMIN_KEY = generateAdminKey();

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function boot(env: Record<string, string>): void {
  const root = mkdtempSync(join(tmpdir(), "oma-admin-transport-"));
  tempRoots.push(root);
  const plane = createDeploymentControlPlane({
    OMA_HOME: root,
    OMA_SQLITE_PATH: join(root, "oma.sqlite"),
    OMA_FILE_STORAGE_ROOT: join(root, "objects"),
    OMA_AUTH_MODE: "api-key",
    ...env,
  });
  plane.stores.close();
}

describe("credential transport gate", () => {
  it("refuses api-key mode on a non-loopback bind without TLS", () => {
    expect(() => boot({ OMA_HOST: "0.0.0.0" })).toThrow(/cleartext/);
  });

  it("refuses an admin key on a non-loopback bind without TLS", () => {
    expect(() => boot({ OMA_ADMIN_KEY: ADMIN_KEY, OMA_HOST: "0.0.0.0" }))
      .toThrow(/cleartext/);
  });

  it("boots when the operator asserts a TLS terminator", () => {
    expect(() =>
      boot({ OMA_ADMIN_KEY: ADMIN_KEY, OMA_HOST: "0.0.0.0", OMA_TLS_TERMINATED: "1" }),
    ).not.toThrow();
  });

  it("boots when the operator explicitly allows insecure transport", () => {
    expect(() =>
      boot({ OMA_ADMIN_KEY: ADMIN_KEY, OMA_HOST: "0.0.0.0", OMA_ALLOW_INSECURE_TRANSPORT: "1" }),
    ).not.toThrow();
  });

  it.each(["127.0.0.1", "localhost", "::1"])(
    "boots frictionless on loopback bind %s",
    (host) => {
      expect(() => boot({ OMA_ADMIN_KEY: ADMIN_KEY, OMA_HOST: host })).not.toThrow();
    },
  );

  it("boots on the default (unset OMA_HOST = loopback)", () => {
    expect(() => boot({ OMA_ADMIN_KEY: ADMIN_KEY })).not.toThrow();
  });

  it("does not gate auth-disabled deployments (no credentials in transit)", () => {
    expect(() =>
      boot({ OMA_AUTH_MODE: "disabled", OMA_HOST: "0.0.0.0" }),
    ).not.toThrow();
  });

  it("refuses an unrecognized flag value instead of coercing it", () => {
    // "true" must not silently mean either yes or no — unknown config
    // refuses to start (house rule), before any store is opened.
    expect(() =>
      boot({ OMA_ADMIN_KEY: ADMIN_KEY, OMA_HOST: "0.0.0.0", OMA_TLS_TERMINATED: "true" }),
    ).toThrow(/OMA_TLS_TERMINATED/);
  });
});

describe("isLoopbackHost", () => {
  it.each([
    [undefined, true],
    ["127.0.0.1", true],
    ["127.1.2.3", true],
    ["localhost", true],
    ["::1", true],
    ["[::1]", true],
    ["0.0.0.0", false],
    ["::", false],
    ["192.168.1.10", false],
    ["example.internal", false],
    // Not provably loopback -> treated as exposed (fail-closed direction).
    ["localhost.evil.com", false],
  ])("%s -> %s", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});
