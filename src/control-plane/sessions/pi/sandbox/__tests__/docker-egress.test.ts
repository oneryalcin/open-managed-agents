import { describe, expect, it } from "vitest";
import {
  buildSidecarRunArgs,
  egressProxyUrl,
} from "../docker-egress.ts";

describe("egress sidecar arg construction (0117d)", () => {
  it("builds a bridge-attached sidecar that mounts the bundle read-only and shared read-write", () => {
    const args = buildSidecarRunArgs({
      containerName: "oma-egress-proxy-x",
      image: "oma-appliance:latest",
      sharedDir: "/host/e/shared",
      bundlePath: "/host/e/bundle.json",
      labels: { "open-managed-agents.session-id": "sesn_1" },
    });
    // Upstream egress via the default bridge; the internal net is attached
    // afterwards by createEgressSidecar.
    expect(args).toContain("--network");
    expect(args).toContain("bridge");
    // Secrets bundle is read-only; the shared dir (ca.crt + ready) is writable.
    expect(args).toContain("/host/e/bundle.json:/bundle.json:ro");
    expect(args).toContain("/host/e/shared:/shared");
    expect(args).toContain("OMA_EGRESS_BUNDLE_PATH=/bundle.json");
    expect(args).toContain("OMA_EGRESS_SHARED_DIR=/shared");
    // Runs the proxy entrypoint, not the control plane.
    expect(args).toContain("src/egress-proxy-main.ts");
    expect(args).toContain("oma-appliance:latest");
    // No repo mount unless asked for (production image carries the source).
    expect(args.join(" ")).not.toContain(":/app:ro");
  });

  it("bind-mounts the repo when the image lacks baked source (dev/test)", () => {
    const args = buildSidecarRunArgs({
      containerName: "oma-egress-proxy-x",
      image: "node:24-slim",
      sharedDir: "/host/e/shared",
      bundlePath: "/host/e/bundle.json",
      repoMount: "/repo",
      labels: {},
    });
    expect(args).toContain("/repo:/app:ro");
  });

  it("puts the auth token in the password slot (matches the proxy's Basic check)", () => {
    expect(
      egressProxyUrl({
        proxyHost: "oma-egress-proxy-x",
        proxyPort: 8080,
        proxyAuthToken: "tok-123",
      }),
    ).toBe("http://srt:tok-123@oma-egress-proxy-x:8080");
  });
});
