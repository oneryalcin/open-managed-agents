import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import { join as joinHostPath } from "node:path";
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { matchGlob } from "./glob.ts";
import {
  createEgressSidecar,
  egressProxyUrl,
  reapEgressSidecars,
} from "./docker-egress.ts";
import type { SessionEgressBundle } from "../../../egress/policy.ts";
import {
  createSandboxInvocationStats,
  createSandboxToolDefinitions,
  recordSandboxInvocation,
  type SandboxDisposedFlag,
  type SandboxOperations,
  type SandboxOutputFile,
  type SandboxProvider,
  type SandboxProviderFactory,
  type SandboxProviderSessionContext,
} from "./provider.ts";
import type { RuntimeSessionFileMount } from "../../../events/types.ts";
import {
  MAX_SESSION_OUTPUT_BYTES,
  MAX_SESSION_OUTPUT_FILE_BYTES,
  MAX_SESSION_OUTPUT_FILES,
} from "../../../files/types.ts";

const DEFAULT_IMAGE = "bash:5.2";
const DEFAULT_WORKSPACE = "/workspace";
const DEFAULT_UPLOADS_PATH = "/mnt/session/uploads";
const DEFAULT_OUTPUTS_PATH = "/mnt/session/outputs";
const DEFAULT_MEMORY = "256m";
const DEFAULT_CPUS = "1";
const DEFAULT_PIDS_LIMIT = "64";
const DEFAULT_TMPFS_SIZE = "64m";
const DEFAULT_OUTPUTS_TMPFS_SIZE = "100m";
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const SANDBOX_LABEL_KEY = "open-managed-agents.sandbox";
const SANDBOX_LABEL_VALUE = "docker-local";
const OWNER_LABEL_KEY = "open-managed-agents.owner";
const OWNER_LABEL_VALUE = "open-managed-agents";
const BASH_DISPATCH_PREFIX = "__OMA_DISPATCHED__:";
const BASH_TERMINAL_PREFIX = "__OMA_TERMINAL__:";

export interface DockerSandboxOptions {
  image?: string;
  dockerCommand?: string;
  workspacePath?: string;
  envAllowlist?: string[];
  operationTimeoutMs?: number;
  containerNamePrefix?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: string;
  tmpfsSize?: string;
  outputsTmpfsSize?: string;
  maxOutputFiles?: number;
  maxOutputFileBytes?: number;
  maxOutputBytes?: number;
  extraLabels?: Record<string, string>;
  reapStaleContainersOlderThanMs?: number;
  /**
   * Per-session proxy-only egress (plan 0117d). When present, the sandbox
   * joins the sidecar's --internal network with the CA + proxy wired in, and
   * the sidecar is torn down when the sandbox is disposed. Absent -> the
   * container stays at --network none.
   */
  egress?: { wiring: SandboxEgressWiring; dispose: () => void };
}

/**
 * Per-(workspace, session) egress bundle resolution (plan 0117e-3, Option A).
 * Built in app.ts, closing over the stores: session -> environment ->
 * networking config -> resolved secrets. `undefined` = the environment grants
 * no egress (default deny; --network none, no sidecar).
 */
export type EgressBundleResolver = (
  workspaceId: string,
  sessionId: string,
  context?: SandboxProviderSessionContext,
) => Promise<
  { bundle: SessionEgressBundle; sandboxEnv: Record<string, string> } | undefined
>;

export interface DockerSandboxEgressFactoryOptions {
  /** Image running egress-proxy-main. Production: the appliance's own tag. */
  sidecarImage: string;
  /** Dev/test: repo bind-mounted at /app when the image lacks OMA source. */
  sidecarRepoMount?: string;
  resolveEgressBundle: EgressBundleResolver;
}

export interface DockerSandboxFactoryOptions
  extends Omit<DockerSandboxOptions, "egress"> {
  /**
   * Deployment-static egress config. Per-session: the factory closure calls
   * `resolveEgressBundle`, stands up the sidecar for a granted environment,
   * and hands `createDockerSandboxProvider` the per-session wiring.
   */
  egress?: DockerSandboxEgressFactoryOptions;
}

export interface DockerSandboxReaperOptions {
  dockerCommand?: string;
  olderThanMs: number;
  labelFilters?: string[];
  now?: () => number;
}

interface DockerSandboxResolvedOptions {
  image: string;
  dockerCommand: string;
  workspacePath: string;
  uploadsPath: string;
  outputsPath: string;
  envAllowlist: Set<string>;
  operationTimeoutMs: number;
  containerNamePrefix: string;
  memory: string;
  cpus: string;
  pidsLimit: string;
  tmpfsSize: string;
  outputsTmpfsSize: string;
  maxOutputFiles: number;
  maxOutputFileBytes: number;
  maxOutputBytes: number;
  extraLabels: Record<string, string>;
}

interface DockerExecOptions {
  input?: Buffer | string;
  onData?: (data: Buffer) => void;
  // onData receives both streams; do not combine it with stream-specific callbacks.
  onStderr?: (data: Buffer) => void;
  onStdout?: (data: Buffer) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxStdoutBytes?: number;
}

interface DockerExecResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
}

type BashTerminalRecord =
  | { kind: "exit"; exitCode: number }
  | { kind: "timeout"; exitCode: number };

export interface DockerShellCommand {
  script: string;
  args: string[];
  input?: Buffer | string;
  interactive?: boolean;
}

export function createDockerSandboxProviderFactory(
  opts: DockerSandboxFactoryOptions = {},
): SandboxProviderFactory {
  const { egress: egressConfig, ...baseOpts } = opts;
  let swept = false;
  let sweepPromise: Promise<void> | undefined;
  return async (workspaceId, sessionId, context) => {
    if (!swept && opts.reapStaleContainersOlderThanMs !== undefined) {
      const olderThanMs = opts.reapStaleContainersOlderThanMs;
      sweepPromise ??= reapDockerSandboxContainers({
        dockerCommand: opts.dockerCommand,
        olderThanMs,
      }).then(
        () => {
          // Same startup sweep reaps egress sidecars a crash orphaned:
          // containers, their --internal networks, and stale temp roots.
          reapEgressSidecars({ dockerCommand: opts.dockerCommand, olderThanMs });
          swept = true;
        },
        (error: unknown) => {
          sweepPromise = undefined;
          throw error;
        },
      );
      await sweepPromise;
    }
    const egress = egressConfig
      ? await createSessionEgress(
          workspaceId,
          sessionId,
          egressConfig,
          baseOpts,
          context,
        )
      : undefined;
    try {
      return await createDockerSandboxProvider(workspaceId, sessionId, {
        ...baseOpts,
        ...(egress === undefined ? {} : { egress }),
      });
    } catch (error) {
      // createDockerSandboxProvider disposes on its own run failure, but a
      // throw before that point (option validation) would leak the sidecar.
      // dispose() is idempotent, so the overlap is harmless.
      egress?.dispose();
      throw error;
    }
  };
}

/**
 * Resolve the session's egress bundle and, when the environment grants
 * egress, stand up the per-session sidecar (plan 0117e-3). Returns undefined
 * for a no-egress environment — the sandbox stays at --network none.
 */
async function createSessionEgress(
  workspaceId: string,
  sessionId: string,
  egressConfig: DockerSandboxEgressFactoryOptions,
  baseOpts: Omit<DockerSandboxOptions, "egress">,
  context: SandboxProviderSessionContext | undefined,
): Promise<NonNullable<DockerSandboxOptions["egress"]> | undefined> {
  const resolved = await egressConfig.resolveEgressBundle(
    workspaceId,
    sessionId,
    context,
  );
  if (resolved === undefined) return undefined;
  const sidecar = await createEgressSidecar({
    dockerCommand: baseOpts.dockerCommand ?? "docker",
    sessionId,
    bundle: resolved.bundle,
    sidecarImage: egressConfig.sidecarImage,
    ...(egressConfig.sidecarRepoMount === undefined
      ? {}
      : { sidecarRepoMount: egressConfig.sidecarRepoMount }),
    operationTimeoutMs: baseOpts.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
  });
  return {
    wiring: {
      networkName: sidecar.networkName,
      caCertDirHostPath: sidecar.sharedDirHostPath,
      proxyUrl: egressProxyUrl(sidecar),
      sandboxEnv: resolved.sandboxEnv,
    },
    dispose: sidecar.dispose,
  };
}

export async function createDockerSandboxProvider(
  workspaceId: string,
  sessionId: string,
  opts: DockerSandboxOptions = {},
): Promise<SandboxProvider> {
  const resolved = resolveDockerOptions(opts);
  const containerName = dockerContainerName(
    resolved.containerNamePrefix,
    workspaceId,
    sessionId,
  );
  try {
    await dockerChecked(
      resolved.dockerCommand,
      buildDockerRunArgs({
        containerName,
        workspacePath: resolved.workspacePath,
        uploadsPath: resolved.uploadsPath,
        outputsPath: resolved.outputsPath,
        image: resolved.image,
        memory: resolved.memory,
        cpus: resolved.cpus,
        pidsLimit: resolved.pidsLimit,
        tmpfsSize: resolved.tmpfsSize,
        outputsTmpfsSize: resolved.outputsTmpfsSize,
        egress: opts.egress?.wiring,
        labels: {
          [SANDBOX_LABEL_KEY]: SANDBOX_LABEL_VALUE,
          [OWNER_LABEL_KEY]: OWNER_LABEL_VALUE,
          "open-managed-agents.workspace-id": workspaceId,
          "open-managed-agents.session-id": sessionId,
          "open-managed-agents.created-at": new Date().toISOString(),
          ...resolved.extraLabels,
        },
      }),
      { timeoutMs: resolved.operationTimeoutMs },
    );
  } catch (error) {
    // Sandbox creation failed after the sidecar was already stood up. The
    // provider whose dispose() tears the sidecar down is never returned, so
    // dispose here — else the sidecar container and its resolved-secret bundle
    // on disk leak.
    opts.egress?.dispose();
    throw error;
  }

  const invocations = createSandboxInvocationStats();
  const disposed: SandboxDisposedFlag = { value: false };
  const activeDockerExecPids = new Set<number>();

  const dockerShell = (
    command: DockerShellCommand,
    execOpts: DockerExecOptions = {},
  ) =>
    dockerChecked(
      resolved.dockerCommand,
      buildDockerExecShellArgs(containerName, command.script, command.args, {
        interactive: command.interactive ?? command.input !== undefined,
        timeoutSeconds:
          (execOpts.timeoutMs ?? resolved.operationTimeoutMs) / 1000,
        workdir: resolved.workspacePath,
      }),
      {
        ...execOpts,
        input: execOpts.input ?? command.input,
        activePids: activeDockerExecPids,
        timeoutMs: execOpts.timeoutMs ?? resolved.operationTimeoutMs,
      },
    );
  const dockerExists = async (absolutePath: string): Promise<boolean> => {
    const command = buildDockerExistsCommand(absolutePath);
    const result = await dockerExec(
      resolved.dockerCommand,
      buildDockerExecShellArgs(containerName, command.script, command.args, {
        timeoutSeconds: resolved.operationTimeoutMs / 1000,
        workdir: resolved.workspacePath,
      }),
      {
        activePids: activeDockerExecPids,
        timeoutMs: resolved.operationTimeoutMs,
      },
    );
    if (result.exitCode === 0) return true;
    throwIfUnexpectedBoundedExit(result, "docker exists", new Set([1]));
    return false;
  };
  const materializeFileResources = async (
    mounts: readonly RuntimeSessionFileMount[],
  ): Promise<void> => {
    if (mounts.length === 0) return;
    recordSandboxNotDisposed(disposed);
    const tempRoot = await mkdtemp(joinHostPath(tmpdir(), "oma-session-mounts-"));
    try {
      for (const mount of mounts) {
        const relativePath = assertInsideUploadsPath(
          mount.mountPath,
          resolved.uploadsPath,
        );
        await writeMountFile(tempRoot, relativePath, mount);
      }
      // Docker exec timeout only owns the local Docker CLI process; the
      // caller must dispose the container on materialization failure so any
      // in-container tar/chown work cannot leak a half-mounted sandbox.
      await dockerChecked(
        resolved.dockerCommand,
        buildDockerExtractIntoContainerArgs(containerName, resolved.uploadsPath),
        {
          input: createTarArchive(tempRoot),
          timeoutMs: resolved.operationTimeoutMs,
        },
      );
      await dockerChecked(
        resolved.dockerCommand,
        buildDockerNormalizeUploadsArgs(containerName, resolved.uploadsPath),
        { timeoutMs: resolved.operationTimeoutMs },
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  };
  const collectOutputFiles = async (): Promise<readonly SandboxOutputFile[]> => {
    recordSandboxNotDisposed(disposed);
    const listing = await dockerShell(
      buildDockerOutputListingCommand(resolved.outputsPath, {
        maxFiles: resolved.maxOutputFiles,
        maxFileBytes: resolved.maxOutputFileBytes,
        maxBytes: resolved.maxOutputBytes,
      }),
    );
    const records = parseOutputListing(listing.stdout);
    return records.map((record) => {
      const absolutePath = assertInsideDockerOutputPath(
        posix.join(resolved.outputsPath, record.relativePath),
        resolved.outputsPath,
      );
      return {
        relativePath: record.relativePath,
        filename: posix.basename(record.relativePath),
        mimeType: mimeTypeForFilename(record.relativePath),
        sizeBytes: record.sizeBytes,
        sha256: record.sha256,
        bytes: dockerOutputBytes(() =>
          dockerShell(buildDockerReadFileCommand(absolutePath), {
            maxStdoutBytes: resolved.maxOutputFileBytes,
          }),
        ),
      };
    });
  };

  const readOps: ReadOperations = {
    access: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "read");
      const path = assertInsideDockerWorkspace(
        absolutePath,
        resolved.workspacePath,
      );
      await dockerShell(buildDockerFileAccessCommand(path, "read"));
    },
    readFile: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "read");
      const path = assertInsideDockerWorkspace(
        absolutePath,
        resolved.workspacePath,
      );
      return (await dockerShell(buildDockerReadFileCommand(path))).stdout;
    },
  };
  const writeOps: WriteOperations = {
    mkdir: async (dir) => {
      recordSandboxInvocation(invocations, disposed, "write");
      const path = assertInsideDockerWorkspace(dir, resolved.workspacePath);
      await dockerShell(buildDockerMkdirCommand(path));
    },
    writeFile: async (absolutePath, content) => {
      recordSandboxInvocation(invocations, disposed, "write");
      const path = assertInsideDockerWorkspace(
        absolutePath,
        resolved.workspacePath,
      );
      await dockerShell(buildDockerWriteFileCommand(path, content));
    },
  };
  const editOps: EditOperations = {
    access: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "edit");
      const path = assertInsideDockerWorkspace(
        absolutePath,
        resolved.workspacePath,
      );
      await dockerShell(buildDockerFileAccessCommand(path, "edit"));
    },
    readFile: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "edit");
      const path = assertInsideDockerWorkspace(
        absolutePath,
        resolved.workspacePath,
      );
      return (await dockerShell(buildDockerReadFileCommand(path))).stdout;
    },
    writeFile: async (absolutePath, content) => {
      recordSandboxInvocation(invocations, disposed, "edit");
      const path = assertInsideDockerWorkspace(
        absolutePath,
        resolved.workspacePath,
      );
      await dockerShell(buildDockerWriteFileCommand(path, content));
    },
  };
  const findOps: FindOperations = {
    exists: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "find");
      const path = assertInsideDockerWorkspace(
        absolutePath,
        resolved.workspacePath,
      );
      return dockerExists(path);
    },
    glob: async (pattern, cwd, options) => {
      recordSandboxInvocation(invocations, disposed, "find");
      const root = assertInsideDockerWorkspace(cwd, resolved.workspacePath);
      const result = await dockerShell(
        buildDockerGlobEnumerationCommand(root, options.ignore),
      );
      const files = result.stdout
        .toString("utf8")
        .split("\n")
        .filter(Boolean);
      return matchGlob(files, pattern, {
        ignore: options.ignore,
        limit: options.limit,
      }).map((rel) => posix.join(root, rel));
    },
  };
  const lsOps: LsOperations = {
    exists: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "ls");
      const path = assertInsideDockerWorkspace(
        absolutePath,
        resolved.workspacePath,
      );
      return dockerExists(path);
    },
    stat: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "ls");
      const path = assertInsideDockerWorkspace(
        absolutePath,
        resolved.workspacePath,
      );
      const result = await dockerShell(buildDockerStatCommand(path));
      const kind = result.stdout.toString("utf8");
      return { isDirectory: () => kind === "directory" };
    },
    readdir: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "ls");
      const path = assertInsideDockerWorkspace(
        absolutePath,
        resolved.workspacePath,
      );
      const result = await dockerShell(buildDockerReaddirCommand(path));
      return result.stdout.toString("utf8").split("\n").filter(Boolean);
    },
  };
  const bashOps: BashOperations = {
    exec: async (command, cwd, options) => {
      recordSandboxInvocation(invocations, disposed, "bash");
      const path = assertInsideDockerWorkspace(cwd, resolved.workspacePath);
      const timeoutSeconds =
        options.timeout !== undefined && options.timeout > 0
          ? options.timeout
          : resolved.operationTimeoutMs / 1000;
      const execId = randomExecId();
      const dispatchToken = randomExecId();
      const pidFile = posix.join(
        resolved.workspacePath,
        `.oma-exec-${execId}.pid`,
      );
      const shellCommand = buildDockerBashCommand(
        command,
        timeoutSeconds,
        pidFile,
        dispatchToken,
      );
      const dispatchFilter = createBashDispatchFilter(dispatchToken);
      try {
        const result = await dockerExec(
          resolved.dockerCommand,
          buildDockerExecShellArgs(
            containerName,
            shellCommand.script,
            shellCommand.args,
            {
              workdir: path,
              env: filterDockerEnv(options.env ?? {}, resolved.envAllowlist),
            },
          ),
          {
            activePids: activeDockerExecPids,
            onAbort: () => {
              killInContainerProcessGroup(
                resolved.dockerCommand,
                containerName,
                pidFile,
              );
            },
            onStderr: (chunk) => {
              const forwarded = dispatchFilter.stderr(chunk);
              if (forwarded.length > 0) options.onData(forwarded);
            },
            onStdout: (chunk) => {
              const forwarded = dispatchFilter.stdout(chunk);
              if (forwarded.length > 0) options.onData(forwarded);
            },
            signal: options.signal,
            timeoutMs: Math.ceil(timeoutSeconds * 1000) + 2_000,
          },
        );
        if (!dispatchFilter.dispatchSeen()) {
          throw new Error("docker bash failed before command dispatch");
        }
        const terminal = dispatchFilter.terminalRecord();
        if (terminal === undefined) {
          throw new Error("docker bash failed before command completion");
        }
        if (
          result.exitCode !==
          (terminal.kind === "timeout" ? 137 : terminal.exitCode)
        ) {
          throw new Error("docker bash exit disagreed with command completion");
        }
        if (terminal.kind === "timeout") {
          throw new DockerTimeoutError();
        }
        return { exitCode: terminal.exitCode };
      } catch (error) {
        if (error instanceof DockerTimeoutError) {
          throw new Error(`timeout:${timeoutSeconds}`);
        }
        throw error;
      }
    },
  };
  const operations: SandboxOperations = {
    bash: bashOps,
    read: readOps,
    write: writeOps,
    edit: editOps,
    find: findOps,
    ls: lsOps,
  };

  return {
    cwd: resolved.workspacePath,
    collectOutputFiles,
    invocations,
    materializeFileResources,
    operations,
    toolNames: new Set(["bash", "read", "write", "edit", "find", "ls"]),
    tools: createSandboxToolDefinitions(
      resolved.workspacePath,
      operations,
      invocations,
      disposed,
    ),
    dispose: () => {
      disposed.value = true;
      for (const pid of activeDockerExecPids) {
        killProcessGroup(pid);
      }
      forceRemoveDockerContainer(resolved.dockerCommand, containerName);
      // Tear down the per-session sidecar + its --internal network last, so a
      // granted egress session leaves no proxy container or network behind.
      opts.egress?.dispose();
    },
  };
}

/**
 * Proxy-only egress wiring (plan 0117d). When present, the sandbox joins the
 * per-session --internal network (its sole route out is the sidecar) instead
 * of `--network none`, trusts the sidecar's MITM CA, and points its HTTP
 * clients at the proxy. Absent → the container stays fully network-isolated.
 */
export interface SandboxEgressWiring {
  /** Per-session --internal network the sidecar is dual-homed on. */
  networkName: string;
  /** Host dir holding ca.crt; bind-mounted read-only at /etc/oma. */
  caCertDirHostPath: string;
  /** `http://srt:<token>@<sidecar>:<port>` — auth token in the password slot. */
  proxyUrl: string;
  /** Per-session sentinels (env var -> sentinel) the agent's tools see. */
  sandboxEnv: Record<string, string>;
}

const SANDBOX_CA_MOUNT = "/etc/oma";
const SANDBOX_CA_CERT_PATH = "/etc/oma/ca.crt";

export function buildDockerRunArgs(opts: {
  containerName: string;
  workspacePath: string;
  uploadsPath?: string;
  outputsPath?: string;
  image: string;
  memory: string;
  cpus: string;
  pidsLimit: string;
  tmpfsSize: string;
  outputsTmpfsSize?: string;
  labels?: Record<string, string>;
  egress?: SandboxEgressWiring;
}): string[] {
  assertTmpfsMemoryHeadroom(
    opts.memory,
    opts.tmpfsSize,
    opts.outputsTmpfsSize ?? opts.tmpfsSize,
  );
  const labels = Object.entries(opts.labels ?? {}).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`,
  ]);
  const uploadsPath = opts.uploadsPath ?? DEFAULT_UPLOADS_PATH;
  const outputsPath = opts.outputsPath ?? DEFAULT_OUTPUTS_PATH;
  const outputsTmpfsSize =
    opts.outputsTmpfsSize ?? DEFAULT_OUTPUTS_TMPFS_SIZE;
  // Default deny (ADR 0016 §2): no egress wiring -> --network none, no proxy.
  const network = opts.egress ? opts.egress.networkName : "none";
  const egressArgs = opts.egress ? buildEgressRunArgs(opts.egress) : [];
  return [
    "run",
    "-d",
    "--name",
    opts.containerName,
    ...labels,
    "--network",
    network,
    ...egressArgs,
    "--cpus",
    opts.cpus,
    "--memory",
    opts.memory,
    "--pids-limit",
    opts.pidsLimit,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    `${opts.workspacePath}:rw,exec,nosuid,nodev,uid=65534,gid=65534,mode=700,size=${opts.tmpfsSize}`,
    "--tmpfs",
    `${uploadsPath}:rw,nosuid,nodev,noexec,mode=755,size=${opts.tmpfsSize}`,
    "--tmpfs",
    `${outputsPath}:rw,nosuid,nodev,noexec,uid=65534,gid=65534,mode=700,size=${outputsTmpfsSize}`,
    "--workdir",
    opts.workspacePath,
    "--user",
    "65534:65534",
    opts.image,
    "tail",
    "-f",
    "/dev/null",
  ];
}

// Trust bundle + proxy env for an egress-granted sandbox. The trust vars point
// at the sidecar's CA so the proxy can terminate TLS; the proxy vars route the
// sandbox's HTTP clients through it. Trust/proxy vars win over sentinels so a
// user-named sentinel cannot shadow the boundary wiring.
function buildEgressRunArgs(egress: SandboxEgressWiring): string[] {
  const env: Record<string, string> = {
    ...egress.sandboxEnv,
    SSL_CERT_FILE: SANDBOX_CA_CERT_PATH,
    NODE_EXTRA_CA_CERTS: SANDBOX_CA_CERT_PATH,
    GIT_SSL_CAINFO: SANDBOX_CA_CERT_PATH,
    CURL_CA_BUNDLE: SANDBOX_CA_CERT_PATH,
    REQUESTS_CA_BUNDLE: SANDBOX_CA_CERT_PATH,
    HTTPS_PROXY: egress.proxyUrl,
    HTTP_PROXY: egress.proxyUrl,
    https_proxy: egress.proxyUrl,
    http_proxy: egress.proxyUrl,
  };
  return [
    "-v",
    `${egress.caCertDirHostPath}:${SANDBOX_CA_MOUNT}:ro`,
    ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
  ];
}

export function buildDockerExtractIntoContainerArgs(
  containerName: string,
  destinationDirectory: string,
): string[] {
  return [
    "exec",
    "-i",
    "--user",
    "0:0",
    containerName,
    "tar",
    "--no-same-owner",
    "-C",
    destinationDirectory,
    "-xf",
    "-",
  ];
}

export function buildDockerNormalizeUploadsArgs(
  containerName: string,
  uploadsPath: string,
): string[] {
  return [
    "exec",
    "--user",
    "0:0",
    containerName,
    "sh",
    "-c",
    "chown -R 0:0 \"$1\" && find \"$1\" -type d -exec chmod 755 {} + && find \"$1\" -type f -exec chmod 644 {} +",
    "sh",
    uploadsPath,
  ];
}

export function buildDockerExecShellArgs(
  containerName: string,
  script: string,
  args: readonly string[],
  opts: {
    workdir?: string;
    env?: NodeJS.ProcessEnv;
    interactive?: boolean;
    timeoutSeconds?: number;
  } = {},
): string[] {
  const out = ["exec"];
  if (opts.interactive) out.push("-i");
  if (opts.workdir) out.push("--workdir", opts.workdir);
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value !== undefined) out.push("--env", `${key}=${value}`);
  }
  if (opts.timeoutSeconds !== undefined && opts.timeoutSeconds > 0) {
    out.push(
      containerName,
      "bash",
      "-lc",
      "timeout -s KILL \"$1\" bash -lc \"$2\" bash \"${@:3}\"",
      "bash",
      String(opts.timeoutSeconds),
      script,
      ...args,
    );
  } else {
    out.push(containerName, "bash", "-lc", script, "bash", ...args);
  }
  return out;
}

export function buildDockerBashCommand(
  command: string,
  timeoutSeconds: number,
  pidFile: string,
  dispatchToken = "",
): DockerShellCommand {
  return {
    script: [
      "pidfile=\"$1\"",
      "timeout_secs=\"$2\"",
      "command=\"$3\"",
      "dispatch_token=\"$4\"",
      "printf '%s\\n' \"__OMA_DISPATCHED__:${dispatch_token}\"",
      "terminal_exit() { printf '%s\\n' \"__OMA_TERMINAL__:${dispatch_token}:exit:$1\"; }",
      "terminal_timeout() { printf '%s\\n' \"__OMA_TERMINAL__:${dispatch_token}:timeout:137\"; }",
      "timer_file=\"${pidfile}.timer\"",
      "rm -f \"$timer_file\"",
      "setsid bash -lc \"$command\" &",
      "pid=$!",
      "printf '%s' \"$pid\" > \"$pidfile\"",
      "setsid sleep \"$timeout_secs\" &",
      "timer=$!",
      "printf '%s' \"$timer\" > \"$timer_file\"",
      "wait -n -p completed \"$pid\" \"$timer\"",
      "status=$?",
      "if [ \"${completed:-}\" = \"$timer\" ]; then",
      "  kill -KILL \"-$pid\" 2>/dev/null || kill -KILL \"$pid\" 2>/dev/null || true",
      "  wait \"$pid\" 2>/dev/null || true",
      "  rm -f \"$pidfile\" \"$timer_file\"",
      "  terminal_timeout",
      "  exit 137",
      "fi",
      "kill \"$timer\" 2>/dev/null || true",
      "wait \"$timer\" 2>/dev/null || true",
      "rm -f \"$pidfile\" \"$timer_file\"",
      "terminal_exit \"$status\"",
      "exit \"$status\"",
    ].join("\n"),
    args: [pidFile, String(timeoutSeconds), command, dispatchToken],
  };
}

export function buildDockerFileAccessCommand(
  absolutePath: string,
  mode: "read" | "edit",
): DockerShellCommand {
  return {
    script:
      mode === "read"
        ? "test -r \"$1\" -a -f \"$1\""
        : "test -r \"$1\" -a -w \"$1\" -a -f \"$1\"",
    args: [absolutePath],
  };
}

export function buildDockerReadFileCommand(
  absolutePath: string,
): DockerShellCommand {
  return { script: "cat \"$1\"", args: [absolutePath] };
}

export function buildDockerWriteFileCommand(
  absolutePath: string,
  content: Buffer | string,
): DockerShellCommand {
  return {
    script: "cat > \"$1\"",
    args: [absolutePath],
    input: content,
    interactive: true,
  };
}

export function buildDockerMkdirCommand(dir: string): DockerShellCommand {
  return { script: "mkdir -p \"$1\"", args: [dir] };
}

export function buildDockerExistsCommand(
  absolutePath: string,
): DockerShellCommand {
  return { script: "test -e \"$1\"", args: [absolutePath] };
}

export function buildDockerStatCommand(absolutePath: string): DockerShellCommand {
  return {
    script:
      "if [ -d \"$1\" ]; then printf directory; elif [ -e \"$1\" ]; then printf file; else exit 1; fi",
    args: [absolutePath],
  };
}

export function buildDockerReaddirCommand(
  absolutePath: string,
): DockerShellCommand {
  return { script: "ls -1A \"$1\"", args: [absolutePath] };
}

export function buildDockerGlobEnumerationCommand(
  root: string,
  ignore: readonly string[] = [],
): DockerShellCommand {
  const prunedDirectoryNames = directoryNamesPrunedByIgnoreGlobs(ignore);
  return {
    script: [
      "cd \"$1\"",
      "shift",
      "if [ \"$#\" -eq 0 ]; then",
      "  find . -type f | sed 's#^./##' | sort",
      "else",
      "  find . \\( -type d \\( \"$@\" \\) -prune \\) -o -type f -print | sed 's#^./##' | sort",
      "fi",
    ].join("\n"),
    args: [
      root,
      ...prunedDirectoryNames.flatMap((name, index) =>
        index === 0 ? ["-name", name] : ["-o", "-name", name],
      ),
    ],
  };
}

export function buildDockerOutputListingCommand(
  outputRoot: string,
  limits: {
    maxFiles: number;
    maxFileBytes: number;
    maxBytes: number;
  } = {
    maxFiles: MAX_SESSION_OUTPUT_FILES,
    maxFileBytes: MAX_SESSION_OUTPUT_FILE_BYTES,
    maxBytes: MAX_SESSION_OUTPUT_BYTES,
  },
): DockerShellCommand {
  return {
    script: [
      "root=\"$1\"",
      "max_files=\"$2\"",
      "max_file_bytes=\"$3\"",
      "max_bytes=\"$4\"",
      "if [ ! -d \"$root\" ]; then exit 0; fi",
      "cd \"$root\"",
      "count=0",
      "total=0",
      "find . -type f -print0 | sort -z | while IFS= read -r -d '' file; do",
      "  rel=\"${file#./}\"",
      "  size=$(wc -c < \"$file\")",
      "  count=$((count + 1))",
      "  if [ \"$count\" -gt \"$max_files\" ]; then",
      "    printf 'session output file count exceeds %s\\n' \"$max_files\" >&2",
      "    exit 42",
      "  fi",
      "  if [ \"$size\" -gt \"$max_file_bytes\" ]; then",
      "    printf 'session output file exceeds %s bytes: %s\\n' \"$max_file_bytes\" \"$rel\" >&2",
      "    exit 42",
      "  fi",
      "  total=$((total + size))",
      "  if [ \"$total\" -gt \"$max_bytes\" ]; then",
      "    printf 'session output bytes exceed %s\\n' \"$max_bytes\" >&2",
      "    exit 42",
      "  fi",
      "  sha=$(sha256sum \"$file\" | awk '{print $1}')",
      "  printf '%s\\0%s\\0%s\\0' \"$rel\" \"$size\" \"$sha\"",
      "done",
    ].join("\n"),
    args: [
      outputRoot,
      String(limits.maxFiles),
      String(limits.maxFileBytes),
      String(limits.maxBytes),
    ],
  };
}

export function directoryNamesPrunedByIgnoreGlobs(
  ignore: readonly string[],
): string[] {
  const names = new Set<string>();
  for (const pattern of ignore) {
    const normalized = pattern.replaceAll("\\", "/");
    const match = /(?:^|\/)([^/*?[\]{}!]+)\/\*\*$/.exec(normalized);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names].sort();
}

export function assertInsideDockerWorkspace(
  absolutePath: string,
  workspacePath = DEFAULT_WORKSPACE,
): string {
  if (!posix.isAbsolute(absolutePath)) {
    throw new Error(`Sandbox path must be absolute: ${absolutePath}`);
  }
  const root = posix.resolve(workspacePath);
  const path = posix.resolve(absolutePath);
  const rel = posix.relative(root, path);
  if (rel === "" || (!rel.startsWith("..") && !posix.isAbsolute(rel))) {
    return path;
  }
  throw new Error(`Sandbox path escapes workspace: ${absolutePath}`);
}

export function assertInsideUploadsPath(
  absolutePath: string,
  uploadsPath = DEFAULT_UPLOADS_PATH,
): string {
  if (!posix.isAbsolute(absolutePath)) {
    throw new Error(`Session file mount path must be absolute: ${absolutePath}`);
  }
  const root = posix.resolve(uploadsPath);
  const path = posix.resolve(absolutePath);
  const rel = posix.relative(root, path);
  if (rel !== "" && !rel.startsWith("..") && !posix.isAbsolute(rel)) {
    return rel;
  }
  throw new Error(`Session file mount path escapes uploads root: ${absolutePath}`);
}

export function assertInsideDockerOutputPath(
  absolutePath: string,
  outputsPath = DEFAULT_OUTPUTS_PATH,
): string {
  if (!posix.isAbsolute(absolutePath)) {
    throw new Error(`Session output path must be absolute: ${absolutePath}`);
  }
  const root = posix.resolve(outputsPath);
  const path = posix.resolve(absolutePath);
  const rel = posix.relative(root, path);
  if (rel !== "" && !rel.startsWith("..") && !posix.isAbsolute(rel)) {
    return path;
  }
  throw new Error(`Session output path escapes outputs root: ${absolutePath}`);
}

function parseOutputListing(
  stdout: Buffer,
): { relativePath: string; sizeBytes: number; sha256: string }[] {
  if (stdout.length === 0) return [];
  const fields = stdout.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 3 !== 0) {
    throw new Error("Docker output listing returned malformed records");
  }
  const out: { relativePath: string; sizeBytes: number; sha256: string }[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    const relativePath = fields[index]!;
    const sizeBytes = Number(fields[index + 1]);
    const sha256 = fields[index + 2]!;
    if (
      relativePath.length === 0 ||
      posix.isAbsolute(relativePath) ||
      relativePath.split("/").includes("..")
    ) {
      throw new Error(`Unsafe session output path: ${relativePath}`);
    }
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new Error(`Invalid session output size: ${relativePath}`);
    }
    if (!/^[0-9a-f]{64}$/i.test(sha256)) {
      throw new Error(`Invalid session output checksum: ${relativePath}`);
    }
    out.push({ relativePath, sizeBytes, sha256 });
  }
  return out;
}

function mimeTypeForFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".pptx")) {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

async function* dockerOutputBytes(
  read: () => Promise<{ stdout: Buffer }>,
): AsyncIterable<Uint8Array> {
  yield (await read()).stdout;
}

async function writeMountFile(
  tempRoot: string,
  relativePath: string,
  mount: RuntimeSessionFileMount,
): Promise<void> {
  const segments = relativePath.split("/");
  const filePath = joinHostPath(tempRoot, ...segments);
  await mkdir(joinHostPath(tempRoot, ...segments.slice(0, -1)), {
    recursive: true,
    mode: 0o755,
  });
  const handle = await open(filePath, "w", 0o644);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of chunksForMount(mount.bytes)) {
      const buffer = Buffer.from(chunk);
      size += buffer.byteLength;
      hash.update(buffer);
      await handle.write(buffer);
    }
  } finally {
    await handle.close();
  }
  const sha256 = hash.digest("hex");
  if (size !== mount.sizeBytes) {
    throw new Error(
      `Session file mount ${mount.snapshotFileId} size mismatch: expected ${mount.sizeBytes}, got ${size}`,
    );
  }
  if (sha256 !== mount.sha256) {
    throw new Error(
      `Session file mount ${mount.snapshotFileId} failed integrity validation`,
    );
  }
}

async function* chunksForMount(
  bytes: RuntimeSessionFileMount["bytes"],
): AsyncIterable<Uint8Array> {
  if (bytes instanceof Uint8Array) {
    yield bytes;
    return;
  }
  yield* bytes;
}

function createTarArchive(sourceDirectory: string): Buffer {
  const result = spawnSync("tar", ["-C", sourceDirectory, "-cf", "-", "."], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `tar archive failed with ${result.status}: ${result.stderr.toString("utf8")}`,
    );
  }
  return result.stdout;
}

export function filterDockerEnv(
  source: NodeJS.ProcessEnv,
  allowlist: ReadonlySet<string>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

export async function reapDockerSandboxContainers(
  opts: DockerSandboxReaperOptions,
): Promise<number> {
  const dockerCommand = opts.dockerCommand ?? "docker";
  const listed = await dockerChecked(dockerCommand, [
    "ps",
    "-aq",
    "--filter",
    `label=${SANDBOX_LABEL_KEY}=${SANDBOX_LABEL_VALUE}`,
    "--filter",
    `label=${OWNER_LABEL_KEY}=${OWNER_LABEL_VALUE}`,
    ...(opts.labelFilters?.flatMap((label) => [
      "--filter",
      `label=${label}`,
    ]) ?? []),
  ]);
  const ids = listed.stdout.toString("utf8").split("\n").filter(Boolean);
  if (ids.length === 0) return 0;
  const now = opts.now?.() ?? Date.now();
  const expired: string[] = [];
  for (const id of ids) {
    const inspected = await dockerChecked(dockerCommand, [
      "inspect",
      id,
      "--format",
      "{{json .Created}}",
    ]);
    const created = JSON.parse(inspected.stdout.toString("utf8")) as string;
    if (now - new Date(created).getTime() >= opts.olderThanMs) {
      expired.push(id);
    }
  }
  if (expired.length === 0) return 0;
  await dockerChecked(dockerCommand, ["rm", "-f", ...expired]);
  return expired.length;
}

function resolveDockerOptions(
  opts: DockerSandboxOptions,
): DockerSandboxResolvedOptions {
  return {
    image: opts.image ?? DEFAULT_IMAGE,
    dockerCommand: opts.dockerCommand ?? "docker",
    workspacePath: opts.workspacePath ?? DEFAULT_WORKSPACE,
    uploadsPath: DEFAULT_UPLOADS_PATH,
    outputsPath: DEFAULT_OUTPUTS_PATH,
    envAllowlist: new Set(opts.envAllowlist ?? []),
    operationTimeoutMs: opts.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    containerNamePrefix: opts.containerNamePrefix ?? "oma-sandbox",
    memory: opts.memory ?? DEFAULT_MEMORY,
    cpus: opts.cpus ?? DEFAULT_CPUS,
    pidsLimit: opts.pidsLimit ?? DEFAULT_PIDS_LIMIT,
    tmpfsSize: opts.tmpfsSize ?? DEFAULT_TMPFS_SIZE,
    outputsTmpfsSize: opts.outputsTmpfsSize ?? DEFAULT_OUTPUTS_TMPFS_SIZE,
    maxOutputFiles: opts.maxOutputFiles ?? MAX_SESSION_OUTPUT_FILES,
    maxOutputFileBytes:
      opts.maxOutputFileBytes ?? MAX_SESSION_OUTPUT_FILE_BYTES,
    maxOutputBytes: opts.maxOutputBytes ?? MAX_SESSION_OUTPUT_BYTES,
    extraLabels: opts.extraLabels ?? {},
  };
}

function assertTmpfsMemoryHeadroom(
  memory: string,
  tmpfsSize: string,
  outputsTmpfsSize: string,
): void {
  const memoryBytes = parseDockerByteSize(memory, "memory");
  const tmpfsBytes = parseDockerByteSize(tmpfsSize, "tmpfsSize");
  const outputTmpfsBytes = parseDockerByteSize(
    outputsTmpfsSize,
    "outputsTmpfsSize",
  );
  if (tmpfsBytes * 2 + outputTmpfsBytes < memoryBytes) return;
  throw new Error(
    "Docker sandbox memory must exceed workspace tmpfs plus uploads tmpfs plus outputs tmpfs",
  );
}

function parseDockerByteSize(value: string, label: string): number {
  const match = /^([1-9][0-9]*)([bkmg])?$/i.exec(value);
  if (!match) {
    throw new Error(
      `Docker sandbox ${label} must use bytes or a k/m/g suffix: ${value}`,
    );
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier =
    unit === "g"
      ? 1024 * 1024 * 1024
      : unit === "m"
        ? 1024 * 1024
        : unit === "k"
          ? 1024
          : 1;
  return amount * multiplier;
}

function dockerContainerName(
  prefix: string,
  workspaceId: string,
  sessionId: string,
): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return [
    sanitizeDockerNamePart(prefix),
    sanitizeDockerNamePart(workspaceId),
    sanitizeDockerNamePart(sessionId),
    Date.now().toString(36),
    suffix,
  ].join("-");
}

function sanitizeDockerNamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "x";
}

function randomExecId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function recordSandboxNotDisposed(disposed: SandboxDisposedFlag): void {
  if (disposed.value) throw new Error("Sandbox provider is disposed");
}

function bashDispatchSentinel(token: string): Buffer {
  return Buffer.from(`${BASH_DISPATCH_PREFIX}${token}\n`);
}

function bashTerminalPrefix(token: string): Buffer {
  return Buffer.from(`${BASH_TERMINAL_PREFIX}${token}:`);
}

export function createBashDispatchFilter(token: string): {
  dispatchSeen: () => boolean;
  terminalRecord: () => BashTerminalRecord | undefined;
  stderr: (chunk: Buffer) => Buffer;
  stdout: (chunk: Buffer) => Buffer;
} {
  const dispatchSentinel = bashDispatchSentinel(token);
  const terminalPrefix = bashTerminalPrefix(token);
  let dispatchSeen = false;
  let terminalRecord: BashTerminalRecord | undefined;
  let terminalCandidate = Buffer.alloc(0);
  let pendingStdout = Buffer.alloc(0);
  let pendingStderr = Buffer.alloc(0);

  const filterAfterDispatch = (chunk: Buffer): Buffer => {
    pendingStdout = Buffer.concat([pendingStdout, chunk]);
    const index = pendingStdout.indexOf(terminalPrefix);
    if (index >= 0) {
      const lineEnd = pendingStdout.indexOf("\n", index);
      if (lineEnd < 0) {
        const out = pendingStdout.subarray(0, index);
        pendingStdout = pendingStdout.subarray(index);
        return out;
      }
      const line = pendingStdout.subarray(index, lineEnd).toString("utf8");
      terminalRecord = parseBashTerminalRecord(line, token);
      const out = Buffer.concat([
        pendingStdout.subarray(0, index),
        pendingStdout.subarray(lineEnd + 1),
      ]);
      pendingStdout = Buffer.alloc(0);
      return out;
    }

    if (terminalCandidate.length > 0) {
      const combined = Buffer.concat([terminalCandidate, pendingStdout]);
      if (isPrefixOf(combined, terminalPrefix)) {
        terminalCandidate = combined;
        pendingStdout = Buffer.alloc(0);
        return Buffer.alloc(0);
      }
      const out = combined;
      terminalCandidate = Buffer.alloc(0);
      pendingStdout = Buffer.alloc(0);
      return out;
    }

    const candidateStart = findTerminalPrefixCandidateStart(
      pendingStdout,
      terminalPrefix,
    );
    if (candidateStart < 0) {
      const out = pendingStdout;
      pendingStdout = Buffer.alloc(0);
      return out;
    }
    const candidate = pendingStdout.subarray(candidateStart);
    if (isPrefixOf(candidate, terminalPrefix)) {
      const out = pendingStdout.subarray(0, candidateStart);
      terminalCandidate = candidate;
      pendingStdout = Buffer.alloc(0);
      return out;
    }
    const out = pendingStdout;
    pendingStdout = Buffer.alloc(0);
    return out;
  };

  return {
    dispatchSeen: () => dispatchSeen,
    terminalRecord: () => terminalRecord,
    stderr: (chunk) => {
      if (dispatchSeen) return chunk;
      pendingStderr = Buffer.concat([pendingStderr, chunk]);
      return Buffer.alloc(0);
    },
    stdout: (chunk) => {
      if (dispatchSeen) return filterAfterDispatch(chunk);
      pendingStdout = Buffer.concat([pendingStdout, chunk]);
      const index = pendingStdout.indexOf(dispatchSentinel);
      if (index < 0) return Buffer.alloc(0);
      dispatchSeen = true;
      const afterDispatch = Buffer.concat([
        pendingStdout.subarray(0, index),
        pendingStderr,
        pendingStdout.subarray(index + dispatchSentinel.length),
      ]);
      pendingStdout = Buffer.alloc(0);
      pendingStderr = Buffer.alloc(0);
      return filterAfterDispatch(afterDispatch);
    },
  };
}

function parseBashTerminalRecord(
  line: string,
  token: string,
): BashTerminalRecord | undefined {
  const prefix = `${BASH_TERMINAL_PREFIX}${token}:`;
  if (!line.startsWith(prefix)) return undefined;
  const payload = line.slice(prefix.length);
  const [kind, exitCodeText, extra] = payload.split(":");
  if (extra !== undefined || !/^(0|[1-9][0-9]*)$/.test(exitCodeText ?? "")) {
    return undefined;
  }
  const exitCode = Number(exitCodeText);
  if (kind === "exit") return { kind, exitCode };
  if (kind === "timeout") return { kind, exitCode };
  return undefined;
}

function findTerminalPrefixCandidateStart(
  buffer: Buffer,
  terminalPrefix: Buffer,
): number {
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === terminalPrefix[0]) return index;
  }
  return -1;
}

function isPrefixOf(candidate: Buffer, value: Buffer): boolean {
  if (candidate.length > value.length) return false;
  return value.subarray(0, candidate.length).equals(candidate);
}

function filterDockerEnvObject(
  env: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function dockerChecked(
  dockerCommand: string,
  args: string[],
  opts: DockerExecOptions & { activePids?: Set<number> } = {},
): Promise<DockerExecResult> {
  const result = await dockerExec(dockerCommand, args, opts);
  if (result.exitCode !== 0) {
    throw new Error(
      `docker ${args.join(" ")} failed with ${result.exitCode}: ${
        result.stderr.toString("utf8") || result.stdout.toString("utf8")
      }`,
    );
  }
  return result;
}

function throwIfUnexpectedBoundedExit(
  result: DockerExecResult,
  context: string,
  normalNonZeroExitCodes: ReadonlySet<number>,
): void {
  if (
    result.exitCode !== null &&
    normalNonZeroExitCodes.has(result.exitCode) &&
    result.stderr.length === 0
  ) {
    return;
  }
  throw new Error(
    `${context} failed with ${result.exitCode}: ${
      result.stderr.toString("utf8") || result.stdout.toString("utf8")
    }`,
  );
}

async function dockerExec(
  dockerCommand: string,
  args: string[],
  opts: DockerExecOptions & { activePids?: Set<number> } = {},
): Promise<DockerExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(dockerCommand, args, {
      detached: true,
      env: filterDockerEnvObject(process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.pid !== undefined) opts.activePids?.add(child.pid);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (child.pid !== undefined) opts.activePids?.delete(child.pid);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const kill = () => {
      if (child.pid === undefined) return;
      killProcessGroup(child.pid);
      if (!child.killed) child.kill();
    };
    const onAbort = () => {
      opts.onAbort?.();
      kill();
      settle(() => reject(new Error("aborted")));
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const maxStdoutBytes = opts.maxStdoutBytes;
      const nextStdoutBytes = stdoutBytes + chunk.byteLength;
      if (
        maxStdoutBytes !== undefined &&
        nextStdoutBytes > maxStdoutBytes
      ) {
        kill();
        settle(() =>
          reject(
            new Error(`docker stdout exceeded ${maxStdoutBytes} bytes`),
          ),
        );
        return;
      }
      stdoutBytes = nextStdoutBytes;
      stdout.push(chunk);
      opts.onStdout?.(chunk);
      opts.onData?.(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      opts.onStderr?.(chunk);
      opts.onData?.(chunk);
    });
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (exitCode) =>
      settle(() =>
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode,
        }),
      ),
    );
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        opts.onAbort?.();
        kill();
        settle(() => reject(new DockerTimeoutError()));
      }, opts.timeoutMs);
    }
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid);
  } catch {
    // The Docker CLI process may already have exited.
  }
}

class DockerTimeoutError extends Error {
  constructor() {
    super("Docker operation timed out");
  }
}

function killInContainerProcessGroup(
  dockerCommand: string,
  containerName: string,
  pidFile: string,
): void {
  spawnSync(
    dockerCommand,
    buildDockerExecShellArgs(
      containerName,
      [
        "pidfile=\"$1\"",
        "timerfile=\"${pidfile}.timer\"",
        "for _ in $(seq 1 50); do",
        "  [ -f \"$pidfile\" ] && break",
        "  sleep 0.01",
        "done",
        "if [ -f \"$timerfile\" ]; then",
        "  timer=$(cat \"$timerfile\")",
        "  kill -KILL \"$timer\" 2>/dev/null || true",
        "fi",
        "if [ -f \"$pidfile\" ]; then",
        "  pid=$(cat \"$pidfile\")",
        "  kill -KILL \"-$pid\" 2>/dev/null || kill -KILL \"$pid\" 2>/dev/null || true",
        "  for _ in $(seq 1 50); do",
        "    kill -0 \"$pid\" 2>/dev/null || break",
        "    sleep 0.02",
        "  done",
        "  rm -f \"$pidfile\" \"$timerfile\"",
        "fi",
      ].join("\n"),
      [pidFile],
    ),
    { stdio: "ignore" },
  );
}

function forceRemoveDockerContainer(
  dockerCommand: string,
  containerName: string,
): void {
  spawnSync(dockerCommand, ["rm", "-f", containerName], { stdio: "ignore" });
}
