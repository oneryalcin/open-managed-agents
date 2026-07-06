import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSidecarRunArgs,
  egressProxyUrl,
  reapEgressSidecars,
  sidecarLabels,
} from "../docker-egress.ts";

describe("egress sidecar arg construction (0117d)", () => {
  it("builds a bridge-attached sidecar that mounts the bundle read-only and shared read-write", () => {
    const args = buildSidecarRunArgs({
      containerName: "oma-egress-proxy-x",
      image: "oma-appliance:latest",
      sharedDir: "/host/e/shared",
      bundlePath: "/host/e/bundle.json",
      user: "501:20",
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

  it("hardens the sidecar to the sandbox's least-privilege standard", () => {
    // The sidecar holds resolved secrets + the MITM CA and is reachable by the
    // sandbox, so a proxy/vendor RCE must not gain more than the sandbox has.
    const args = buildSidecarRunArgs({
      containerName: "oma-egress-proxy-x",
      image: "oma-appliance:latest",
      sharedDir: "/host/e/shared",
      bundlePath: "/host/e/bundle.json",
      user: "501:20",
      labels: {},
    });
    expect(args).toContain("--cap-drop");
    expect(args).toContain("ALL");
    expect(args).toContain("--security-opt");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("--read-only");
    expect(args).toContain("--user");
    expect(args).toContain("501:20");
    expect(args).toContain("--memory");
    expect(args).toContain("--pids-limit");
    // Read-only root: node needs a writable tmpfs for CA minting + HOME.
    expect(args).toContain("--tmpfs");
    expect(args.some((a) => a.startsWith("/tmp:rw"))).toBe(true);
    expect(args).toContain("HOME=/tmp");
  });

  it("bind-mounts the repo when the image lacks baked source (dev/test)", () => {
    const args = buildSidecarRunArgs({
      containerName: "oma-egress-proxy-x",
      image: "node:24-slim",
      sharedDir: "/host/e/shared",
      bundlePath: "/host/e/bundle.json",
      repoMount: "/repo",
      user: "501:20",
      labels: {},
    });
    expect(args).toContain("/repo:/app:ro");
  });

  it("percent-encodes the auth token so a URL delimiter cannot malform the proxy URL", () => {
    const url = egressProxyUrl({
      proxyHost: "oma-egress-proxy-x",
      proxyPort: 8080,
      proxyAuthToken: "tok-123",
    });
    expect(url).toBe("http://srt:tok-123@oma-egress-proxy-x:8080");
    // A delimiter-bearing token round-trips: the parsed password decodes back
    // to the exact token, and the host is not hijacked by an embedded '@'.
    const nasty = egressProxyUrl({
      proxyHost: "oma-egress-proxy-x",
      proxyPort: 8080,
      proxyAuthToken: "a@b:c/d?e#f",
    });
    const parsed = new URL(nasty);
    expect(parsed.hostname).toBe("oma-egress-proxy-x");
    expect(decodeURIComponent(parsed.password)).toBe("a@b:c/d?e#f");
  });

  it("never lets caller labels shadow the reserved reaper/ownership labels", () => {
    const merged = sidecarLabels(
      {
        // A caller trying to hide the sidecar from the crash reaper.
        "open-managed-agents.egress-sidecar": "not-docker-local",
        "open-managed-agents.session-id": "spoofed",
        "team": "blue",
      },
      "sesn_real",
    );
    expect(merged["open-managed-agents.egress-sidecar"]).toBe("docker-local");
    expect(merged["open-managed-agents.session-id"]).toBe("sesn_real");
    expect(merged["team"]).toBe("blue"); // unrelated caller labels still pass through
  });
});

describe("reapEgressSidecars temp-root sweep (crash cleanup, age-bounded)", () => {
  let parent: string;
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "oma-egress-reap-test-"));
  });
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it("removes only stale oma-egress-* roots and never unrelated dirs", () => {
    const now = 1_000_000_000_000;
    const stale = join(parent, "oma-egress-stale");
    const fresh = join(parent, "oma-egress-fresh");
    const unrelated = join(parent, "some-other-tmpdir");
    for (const d of [stale, fresh, unrelated]) mkdirSync(d);
    // Backdate the stale root well beyond the threshold; leave the others new.
    const staleSecs = (now - 60_000) / 1000;
    utimesSync(stale, staleSecs, staleSecs);
    const freshSecs = (now - 1_000) / 1000;
    utimesSync(fresh, freshSecs, freshSecs);
    utimesSync(unrelated, staleSecs, staleSecs);

    // `true` no-ops the docker container/network calls; the sweep is what we test.
    reapEgressSidecars({
      dockerCommand: "true",
      olderThanMs: 30_000,
      now: () => now,
      tmpDir: parent,
    });

    expect(existsSync(stale)).toBe(false); // stale egress root reaped
    expect(existsSync(fresh)).toBe(true); // within threshold — a live session's
    expect(existsSync(unrelated)).toBe(true); // never touch non-egress dirs
  });

  it("scrubs a crash-orphaned bundle.json from a still-young root, keeping the dir", () => {
    // #143: a control-plane crash before sidecar readiness can leave a 0600
    // bundle.json inside a temp root that is younger than the (24h) whole-dir
    // threshold — so the dir must NOT be reaped (its ca.crt could be bind-
    // mounted into a live sandbox), but the secret file must not linger.
    const now = 1_000_000_000_000;
    const crashed = join(parent, "oma-egress-crashed");
    const booting = join(parent, "oma-egress-booting");
    for (const d of [crashed, booting]) mkdirSync(d);
    // Both dirs are young (well within the 30s dir threshold): live/recent.
    const youngSecs = (now - 2_000) / 1000;
    utimesSync(crashed, youngSecs, youngSecs);
    utimesSync(booting, youngSecs, youngSecs);

    const crashedBundle = join(crashed, "bundle.json");
    const bootingBundle = join(booting, "bundle.json");
    writeFileSync(crashedBundle, "SECRETS", { mode: 0o600 });
    writeFileSync(bootingBundle, "SECRETS", { mode: 0o600 });
    // Crash orphan: bundle older than any readiness timeout (60s) -> scrub.
    const orphanSecs = (now - 60_000) / 1000;
    utimesSync(crashedBundle, orphanSecs, orphanSecs);
    // Sibling process still booting: bundle just written (1s) -> must be kept.
    const freshSecs = (now - 1_000) / 1000;
    utimesSync(bootingBundle, freshSecs, freshSecs);

    reapEgressSidecars({
      dockerCommand: "true",
      olderThanMs: 30_000,
      now: () => now,
      tmpDir: parent,
    });

    expect(existsSync(crashed)).toBe(true); // young dir kept (live-sandbox safe)
    expect(existsSync(crashedBundle)).toBe(false); // orphaned secret scrubbed
    expect(existsSync(booting)).toBe(true);
    expect(existsSync(bootingBundle)).toBe(true); // not raced out from under boot
  });
});
