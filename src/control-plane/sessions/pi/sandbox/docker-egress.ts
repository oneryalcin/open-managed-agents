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
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEgressBundle } from "../../../egress/policy.ts";

const SIDECAR_LABEL_KEY = "open-managed-agents.egress-sidecar";
const SIDECAR_LABEL_VALUE = "docker-local";
const DEFAULT_READINESS_TIMEOUT_MS = 20_000;
export const DEFAULT_SIDECAR_PORT = 8080;
const DEFAULT_SIDECAR_MEMORY = "256m";
const DEFAULT_SIDECAR_PIDS_LIMIT = "128";
const DEFAULT_SIDECAR_TMPFS_SIZE = "64m";

/** `<uid>:<gid>` the sidecar runs as: the control-plane's own ids. */
function currentUserSpec(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  return `${uid}:${gid}`;
}

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

/**
 * The proxy URL a sandbox uses: auth token rides in the password slot. The
 * token is percent-encoded so a URL delimiter (`@ : / ? #`) can't malform the
 * URL or change the credentials the client sends (the seam also constrains the
 * charset — {@link resolveSessionEgressBundle} — so this is defense in depth).
 */
export function egressProxyUrl(sidecar: {
  proxyHost: string;
  proxyPort: number;
  proxyAuthToken: string;
}): string {
  const token = encodeURIComponent(sidecar.proxyAuthToken);
  return `http://srt:${token}@${sidecar.proxyHost}:${sidecar.proxyPort}`;
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
      [
        "network",
        "create",
        "--internal",
        "--label",
        `${SIDECAR_LABEL_KEY}=${SIDECAR_LABEL_VALUE}`,
        "--label",
        `open-managed-agents.session-id=${opts.sessionId}`,
        networkName,
      ],
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
        user: currentUserSpec(),
        labels: sidecarLabels(opts.labels, opts.sessionId),
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
    // The sidecar has read the bundle into memory by the time it signals ready.
    // Drop the plaintext-secret file from disk now so a later control-plane
    // crash (before dispose) leaves no resolved secrets behind — the at-rest
    // window shrinks to the ~1s of sidecar startup.
    rmSync(bundlePath, { force: true });

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

/**
 * Merge caller labels with the reserved ownership labels the crash reaper
 * matches on. Caller labels are applied FIRST so they can never shadow the
 * reserved keys — otherwise a caller could hide a sidecar from reaping.
 */
export function sidecarLabels(
  callerLabels: Record<string, string> | undefined,
  sessionId: string,
): Record<string, string> {
  return {
    ...callerLabels,
    [SIDECAR_LABEL_KEY]: SIDECAR_LABEL_VALUE,
    "open-managed-agents.session-id": sessionId,
  };
}

export function buildSidecarRunArgs(opts: {
  containerName: string;
  image: string;
  sharedDir: string;
  bundlePath: string;
  repoMount?: string;
  labels: Record<string, string>;
  /**
   * `<uid>:<gid>` the sidecar runs as — the control-plane's own ids, so the
   * process can read the 0600 secret bundle and write the shared dir it
   * mounts (both host-owned by the control plane) while still being non-root.
   */
  user: string;
  memory?: string;
  pidsLimit?: string;
  tmpfsSize?: string;
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
    // attached afterwards. The sidecar is now part of the security boundary
    // (it holds resolved secrets + the MITM CA and is reachable by the
    // sandbox), so it gets the same least-privilege hardening as the sandbox
    // (docker.ts buildDockerRunArgs): no caps, no new privs, read-only root,
    // non-root, resource-bounded. Its ONLY writable surface is a small tmpfs
    // (CA minting) plus the shared dir it must publish ca.crt/ready to.
    "--network",
    "bridge",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${opts.tmpfsSize ?? DEFAULT_SIDECAR_TMPFS_SIZE}`,
    "--user",
    opts.user,
    "--memory",
    opts.memory ?? DEFAULT_SIDECAR_MEMORY,
    "--pids-limit",
    opts.pidsLimit ?? DEFAULT_SIDECAR_PIDS_LIMIT,
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
    // Read-only root + non-root: give node a writable HOME on the tmpfs.
    "--env",
    "HOME=/tmp",
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
  /** Only reap resources older than this. 0 (default) reaps everything. */
  olderThanMs?: number;
  now?: () => number;
  /** Temp root parent to sweep for orphaned oma-egress-* dirs. */
  tmpDir?: string;
}

/**
 * Crash cleanup for egress sidecars — the happy path is `EgressSidecar.dispose`;
 * this reaps what a control-plane crash orphaned. Removes labelled sidecar
 * CONTAINERS and per-session `--internal` NETWORKS older than the threshold,
 * and sweeps stale `oma-egress-*` temp roots (which hold only ca.crt/ready once
 * the bundle is unlinked at readiness, but are cleaned for tidiness). Meant to
 * run once at startup, like `reapDockerSandboxContainers`, so it never races a
 * live session's own sidecar.
 */
export function reapEgressSidecars(opts: EgressSidecarReaperOptions = {}): void {
  const dockerCommand = opts.dockerCommand ?? "docker";
  const olderThanMs = opts.olderThanMs ?? 0;
  const now = opts.now?.() ?? Date.now();
  const filter = ["--filter", `label=${SIDECAR_LABEL_KEY}=${SIDECAR_LABEL_VALUE}`];

  const expired = (kind: "container" | "network", ids: string[]): string[] =>
    ids.filter((id) => {
      const created = dockerCreatedAt(dockerCommand, kind, id);
      return created === undefined || now - created >= olderThanMs;
    });

  const containers = dockerList(dockerCommand, ["ps", "-aq", ...filter]);
  const staleContainers = expired("container", containers);
  if (staleContainers.length > 0) {
    spawnSync(dockerCommand, ["rm", "-f", ...staleContainers], { stdio: "ignore" });
  }

  const networks = dockerList(dockerCommand, ["network", "ls", "-q", ...filter]);
  const staleNetworks = expired("network", networks);
  for (const id of staleNetworks) {
    // A network with a still-live endpoint refuses removal; that is correct —
    // only orphans are reaped.
    spawnSync(dockerCommand, ["network", "rm", id], { stdio: "ignore" });
  }

  sweepStaleTempRoots(opts.tmpDir ?? tmpdir(), olderThanMs, now);
}

function dockerList(dockerCommand: string, args: string[]): string[] {
  const result = spawnSync(dockerCommand, args, { encoding: "utf8" });
  return (result.stdout ?? "").split("\n").filter(Boolean);
}

function dockerCreatedAt(
  dockerCommand: string,
  kind: "container" | "network",
  id: string,
): number | undefined {
  const args =
    kind === "network"
      ? ["network", "inspect", id, "--format", "{{json .Created}}"]
      : ["inspect", id, "--format", "{{json .Created}}"];
  const result = spawnSync(dockerCommand, args, { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  try {
    const created = JSON.parse(result.stdout) as string;
    const ms = new Date(created).getTime();
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

function sweepStaleTempRoots(
  parent: string,
  olderThanMs: number,
  now: number,
): void {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith("oma-egress-")) continue;
    const full = join(parent, name);
    try {
      const stat = statSync(full);
      if (!stat.isDirectory()) continue;
      if (now - stat.mtimeMs >= olderThanMs) {
        rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // gone already / racing another reaper — fine
    }
  }
}
