import { spawn, spawnSync } from "node:child_process";
import { posix } from "node:path";
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
  createSandboxInvocationStats,
  createSandboxToolDefinitions,
  recordSandboxInvocation,
  type SandboxDisposedFlag,
  type SandboxOperations,
  type SandboxProvider,
  type SandboxProviderFactory,
} from "./provider.ts";

const DEFAULT_IMAGE = "alpine:3.19";
const DEFAULT_WORKSPACE = "/workspace";
const DEFAULT_MEMORY = "128m";
const DEFAULT_CPUS = "1";
const DEFAULT_PIDS_LIMIT = "64";
const DEFAULT_TMPFS_SIZE = "64m";
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const SANDBOX_LABEL_KEY = "open-managed-agents.sandbox";
const SANDBOX_LABEL_VALUE = "docker-local";
const OWNER_LABEL_KEY = "open-managed-agents.owner";
const OWNER_LABEL_VALUE = "open-managed-agents";

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
  extraLabels?: Record<string, string>;
  reapStaleContainersOlderThanMs?: number;
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
  envAllowlist: Set<string>;
  operationTimeoutMs: number;
  containerNamePrefix: string;
  memory: string;
  cpus: string;
  pidsLimit: string;
  tmpfsSize: string;
  extraLabels: Record<string, string>;
}

interface DockerExecOptions {
  input?: Buffer | string;
  onData?: (data: Buffer) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface DockerExecResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
}

export interface DockerShellCommand {
  script: string;
  args: string[];
  input?: Buffer | string;
  interactive?: boolean;
}

export function createDockerSandboxProviderFactory(
  opts: DockerSandboxOptions = {},
): SandboxProviderFactory {
  let swept = false;
  return async (workspaceId, sessionId) => {
    if (!swept && opts.reapStaleContainersOlderThanMs !== undefined) {
      swept = true;
      await reapDockerSandboxContainers({
        dockerCommand: opts.dockerCommand,
        olderThanMs: opts.reapStaleContainersOlderThanMs,
      });
    }
    return createDockerSandboxProvider(workspaceId, sessionId, opts);
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
  await dockerChecked(
    resolved.dockerCommand,
    buildDockerRunArgs({
      containerName,
      workspacePath: resolved.workspacePath,
      image: resolved.image,
      memory: resolved.memory,
      cpus: resolved.cpus,
      pidsLimit: resolved.pidsLimit,
      tmpfsSize: resolved.tmpfsSize,
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
        workdir: resolved.workspacePath,
      }),
      {
        activePids: activeDockerExecPids,
        timeoutMs: resolved.operationTimeoutMs,
      },
    );
    return result.exitCode === 0;
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
      const result = await dockerShell(buildDockerGlobEnumerationCommand(root));
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
      try {
        const result = await dockerExec(
          resolved.dockerCommand,
          buildDockerExecShellArgs(containerName, command, [], {
            workdir: path,
            env: filterDockerEnv(options.env ?? {}, resolved.envAllowlist),
          }),
          {
            activePids: activeDockerExecPids,
            onData: options.onData,
            signal: options.signal,
            timeoutMs:
              options.timeout !== undefined && options.timeout > 0
                ? options.timeout * 1000
                : undefined,
          },
        );
        return { exitCode: result.exitCode };
      } catch (error) {
        if (error instanceof DockerTimeoutError && options.timeout !== undefined) {
          throw new Error(`timeout:${options.timeout}`);
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
    invocations,
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
      spawnSync(resolved.dockerCommand, ["rm", "-f", containerName], {
        stdio: "ignore",
      });
    },
  };
}

export function buildDockerRunArgs(opts: {
  containerName: string;
  workspacePath: string;
  image: string;
  memory: string;
  cpus: string;
  pidsLimit: string;
  tmpfsSize: string;
  labels?: Record<string, string>;
}): string[] {
  const labels = Object.entries(opts.labels ?? {}).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`,
  ]);
  return [
    "run",
    "-d",
    "--name",
    opts.containerName,
    ...labels,
    "--network",
    "none",
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

export function buildDockerExecShellArgs(
  containerName: string,
  script: string,
  args: readonly string[],
  opts: {
    workdir?: string;
    env?: NodeJS.ProcessEnv;
    interactive?: boolean;
  } = {},
): string[] {
  const out = ["exec"];
  if (opts.interactive) out.push("-i");
  if (opts.workdir) out.push("--workdir", opts.workdir);
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value !== undefined) out.push("--env", `${key}=${value}`);
  }
  out.push(containerName, "sh", "-lc", script, "sh", ...args);
  return out;
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
): DockerShellCommand {
  return {
    script: "cd \"$1\" && find . -type f | sed 's#^./##' | sort | head -n 10000",
    args: [root],
  };
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
  const listed = await dockerExec(dockerCommand, [
    "ps",
    "-aq",
    "--filter",
    `label=${SANDBOX_LABEL_KEY}=${SANDBOX_LABEL_VALUE}`,
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
    const inspected = await dockerExec(dockerCommand, [
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
  await dockerExec(dockerCommand, ["rm", "-f", ...expired]);
  return expired.length;
}

function resolveDockerOptions(
  opts: DockerSandboxOptions,
): DockerSandboxResolvedOptions {
  return {
    image: opts.image ?? DEFAULT_IMAGE,
    dockerCommand: opts.dockerCommand ?? "docker",
    workspacePath: opts.workspacePath ?? DEFAULT_WORKSPACE,
    envAllowlist: new Set(opts.envAllowlist ?? []),
    operationTimeoutMs: opts.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    containerNamePrefix: opts.containerNamePrefix ?? "oma-sandbox",
    memory: opts.memory ?? DEFAULT_MEMORY,
    cpus: opts.cpus ?? DEFAULT_CPUS,
    pidsLimit: opts.pidsLimit ?? DEFAULT_PIDS_LIMIT,
    tmpfsSize: opts.tmpfsSize ?? DEFAULT_TMPFS_SIZE,
    extraLabels: opts.extraLabels ?? {},
  };
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
      kill();
      settle(() => reject(new Error("aborted")));
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      opts.onData?.(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
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
