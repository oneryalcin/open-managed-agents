// Per-session dual-homed egress proxy sidecar (plan 0117d; ADR 0016 §2/§3).
//
// Topology (probe-validated 2026-07-05): an in-process host proxy is
// unreachable from a confined sandbox — an `--internal` Docker network drops
// host-gateway traffic, and a plain bridge leaks the whole internet. The only
// mode giving both reachability AND confinement is a dual-homed proxy:
//
//     sandbox ──[oma-egress-<sid>, --internal]──▶ proxy sidecar ──[bridge]──▶ upstreams
//
// The sandbox joins the internal-only network, whose sole route out is the
// sidecar; a raw socket to anything else is dropped by --internal. The sidecar
// runs the SAME appliance image, only a different command (egress-proxy-main),
// so the proxy lives OUT of the long-lived control-plane process and the
// control plane never joins the sandbox network.
//
// Secret/CA delivery: the control plane writes the resolved SessionEgressBundle
// (real secrets) to a sidecar-only mount (mode 0600, never the sandbox, never
// env). The sidecar mints its own MITM CA and publishes only the cert to a
// shared dir; the CA private key never leaves the sidecar. The control plane
// waits for the sidecar's `ready` marker, then mounts that cert into the
// sandbox trust bundle.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEgressBundle } from "../../../egress/policy.ts";

const SIDECAR_LABEL_KEY = "open-managed-agents.egress-sidecar";
const SIDECAR_LABEL_VALUE = "docker-local";
const DEFAULT_READINESS_TIMEOUT_MS = 20_000;
const DEFAULT_SIDECAR_PORT = 8080;

export interface CreateEgressSidecarOptions {
  dockerCommand: string;
  sessionId: string;
  bundle: SessionEgressBundle;
  /** Image running egress-proxy-main. Production: the appliance image. */
  sidecarImage: string;
  /**
   * Host path bind-mounted read-only at /app when `sidecarImage` does not
   * already carry the OMA source (dev/test use node:24-slim + the repo).
   */
  sidecarRepoMount?: string;
  operationTimeoutMs: number;
  labels?: Record<string, string>;
  readinessTimeoutMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  sleepMs?: (ms: number) => Promise<void>;
}

export interface EgressSidecar {
  /** Per-session --internal network the sandbox must join. */
  networkName: string;
  /** Sidecar container name — resolvable by DNS on the internal network. */
  proxyHost: string;
  proxyPort: number;
  proxyAuthToken: string;
  /** Host dir holding ca.crt (+ ready); bind-mount read-only into the sandbox. */
  sharedDirHostPath: string;
  dispose(): void;
}

/** The proxy URL a sandbox uses: auth token rides in the password slot. */
export function egressProxyUrl(sidecar: {
  proxyHost: string;
  proxyPort: number;
  proxyAuthToken: string;
}): string {
  return `http://srt:${sidecar.proxyAuthToken}@${sidecar.proxyHost}:${sidecar.proxyPort}`;
}

export async function createEgressSidecar(
  opts: CreateEgressSidecarOptions,
): Promise<EgressSidecar> {
  const now = opts.now ?? Date.now;
  const port = opts.bundle.listenPort || DEFAULT_SIDECAR_PORT;
  const suffix = `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const networkName = `oma-egress-${sanitize(opts.sessionId)}-${suffix}`;
  const containerName = `oma-egress-proxy-${sanitize(opts.sessionId)}-${suffix}`;

  const root = mkdtempSync(join(tmpdir(), "oma-egress-"));
  const sharedDir = join(root, "shared");
  const bundlePath = join(root, "bundle.json");
  // Real secrets live here; only the sidecar mounts it, and only the owner
  // can read it.
  mkdirSync(sharedDir, { recursive: true });
  writeFileSync(bundlePath, JSON.stringify(opts.bundle), { mode: 0o600 });

  let networkCreated = false;
  let containerStarted = false;
  const dispose = (): void => {
    if (containerStarted) {
      spawnSync(opts.dockerCommand, ["rm", "-f", containerName], {
        stdio: "ignore",
      });
    }
    if (networkCreated) {
      spawnSync(opts.dockerCommand, ["network", "rm", networkName], {
        stdio: "ignore",
      });
    }
    rmSync(root, { recursive: true, force: true });
  };

  try {
    dockerOrThrow(
      opts.dockerCommand,
      ["network", "create", "--internal", networkName],
      opts.operationTimeoutMs,
    );
    networkCreated = true;

    dockerOrThrow(
      opts.dockerCommand,
      buildSidecarRunArgs({
        containerName,
        image: opts.sidecarImage,
        sharedDir,
        bundlePath,
        repoMount: opts.sidecarRepoMount,
        labels: {
          [SIDECAR_LABEL_KEY]: SIDECAR_LABEL_VALUE,
          "open-managed-agents.session-id": opts.sessionId,
          ...opts.labels,
        },
      }),
      opts.operationTimeoutMs,
    );
    containerStarted = true;

    // Dual-home: the run above put the sidecar on the default bridge (upstream
    // egress); now attach the per-session internal net (sandbox side).
    dockerOrThrow(
      opts.dockerCommand,
      ["network", "connect", networkName, containerName],
      opts.operationTimeoutMs,
    );

    await waitForReady(
      join(sharedDir, "ready"),
      opts.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      now,
      opts.sleepMs ?? sleepAsync,
      () => sidecarLogs(opts.dockerCommand, containerName),
    );

    return {
      networkName,
      proxyHost: containerName,
      proxyPort: port,
      proxyAuthToken: opts.bundle.proxyAuthToken,
      sharedDirHostPath: sharedDir,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

export function buildSidecarRunArgs(opts: {
  containerName: string;
  image: string;
  sharedDir: string;
  bundlePath: string;
  repoMount?: string;
  labels: Record<string, string>;
}): string[] {
  const labels = Object.entries(opts.labels).flatMap(([k, v]) => [
    "--label",
    `${k}=${v}`,
  ]);
  return [
    "run",
    "-d",
    "--name",
    opts.containerName,
    // Start on the default bridge for upstream egress; the internal net is
    // attached afterwards. Sidecar is hardened but must reach real upstreams.
    "--network",
    "bridge",
    ...labels,
    ...(opts.repoMount ? ["-v", `${opts.repoMount}:/app:ro`] : []),
    "-v",
    `${opts.sharedDir}:/shared`,
    "-v",
    `${opts.bundlePath}:/bundle.json:ro`,
    "--env",
    "OMA_EGRESS_BUNDLE_PATH=/bundle.json",
    "--env",
    "OMA_EGRESS_SHARED_DIR=/shared",
    "--workdir",
    "/app",
    opts.image,
    "node",
    "--experimental-transform-types",
    "--disable-warning=ExperimentalWarning",
    "src/egress-proxy-main.ts",
  ];
}

async function waitForReady(
  readyPath: string,
  timeoutMs: number,
  now: () => number,
  sleepMs: (ms: number) => Promise<void>,
  logs: () => string,
): Promise<void> {
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      statSync(readyPath);
      return;
    } catch {
      // not ready yet
    }
    if (now() >= deadline) {
      throw new Error(
        `egress sidecar did not become ready within ${timeoutMs}ms:\n${logs()}`,
      );
    }
    await sleepMs(100);
  }
}

function sidecarLogs(dockerCommand: string, containerName: string): string {
  const result = spawnSync(dockerCommand, ["logs", "--tail", "40", containerName], {
    encoding: "utf8",
  });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function dockerOrThrow(
  dockerCommand: string,
  args: string[],
  timeoutMs: number,
): void {
  const result = spawnSync(dockerCommand, args, {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (result.status !== 0) {
    throw new Error(
      `docker ${args.join(" ")} failed with ${result.status}: ${
        result.stderr || result.stdout || "(no output)"
      }`,
    );
  }
}

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitize(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "x"
  );
}

export interface EgressSidecarReaperOptions {
  dockerCommand?: string;
}

/** Remove orphaned egress sidecars (crash cleanup). Networks are pruned too. */
export function reapEgressSidecars(opts: EgressSidecarReaperOptions = {}): void {
  const dockerCommand = opts.dockerCommand ?? "docker";
  const listed = spawnSync(
    dockerCommand,
    ["ps", "-aq", "--filter", `label=${SIDECAR_LABEL_KEY}=${SIDECAR_LABEL_VALUE}`],
    { encoding: "utf8" },
  );
  const ids = (listed.stdout ?? "").split("\n").filter(Boolean);
  if (ids.length > 0) {
    spawnSync(dockerCommand, ["rm", "-f", ...ids], { stdio: "ignore" });
  }
}
