import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startEgressProxySidecar } from "../../egress-proxy-main.ts";

describe("egress proxy sidecar entrypoint (plan 0117d)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oma-sidecar-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("publishes the full trust bundle (MITM CA + public roots), not just the CA", async () => {
    const bundlePath = join(dir, "bundle.json");
    const sharedDir = join(dir, "shared");
    mkdirSync(sharedDir);
    writeFileSync(
      bundlePath,
      JSON.stringify({
        policy: { allow: [], credentials: [] },
        grants: [],
        secrets: {},
        proxyAuthToken: "tok",
        listenPort: 0, // ephemeral — the test never connects
      }),
    );

    const running = await startEgressProxySidecar({
      OMA_EGRESS_BUNDLE_PATH: bundlePath,
      OMA_EGRESS_SHARED_DIR: sharedDir,
      OMA_EGRESS_BIND_HOST: "127.0.0.1",
    });
    try {
      const published = readFileSync(join(sharedDir, "ca.crt"), "utf8");
      const certs = published.match(/BEGIN CERTIFICATE/g) ?? [];
      // Publishing only the MITM CA (1 cert) would REPLACE the sandbox's public
      // root store, breaking TLS verification for any opaque-tunnel host the
      // proxy does not terminate. The trust bundle carries CA + public roots.
      expect(certs.length).toBeGreaterThan(1);
    } finally {
      await running.stop();
    }
  });
});
