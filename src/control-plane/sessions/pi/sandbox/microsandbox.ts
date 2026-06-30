import { spawn, spawnSync } from "node:child_process";
import { dirname } from "node:path";

export const DEFAULT_MICROSANDBOX_COMMAND = "msb";
export const DEFAULT_MICROSANDBOX_IMAGE = "docker.io/library/alpine:latest";
export const DEFAULT_MICROSANDBOX_WORKSPACE = "/workspace";
export const DEFAULT_MICROSANDBOX_UPLOADS_PATH = "/mnt/session/uploads";
export const DEFAULT_MICROSANDBOX_OUTPUTS_PATH = "/mnt/session/outputs";
export const DEFAULT_MICROSANDBOX_MAX_BUFFER = 16 * 1024 * 1024;

const MICROSANDBOX_ENV_ALLOWLIST = new Set([
  "HOME",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
]);

export interface MicrosandboxCliResult {
  stdout: Buffer;
  stderr: Buffer;
  // Trust the local msb process status/signal, not guest-forgeable stdout.
  status: number | null;
  signal: NodeJS.Signals | null;
}

export interface MicrosandboxCliExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: Buffer | string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface MicrosandboxCli {
  exec(
    args: readonly string[],
    opts?: MicrosandboxCliExecOptions,
  ): Promise<MicrosandboxCliResult>;
  execSync(
    args: readonly string[],
    opts?: Omit<MicrosandboxCliExecOptions, "signal">,
  ): MicrosandboxCliResult;
}

export interface NodeMicrosandboxCliOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  nodeExecutable?: string;
}

export class NodeMicrosandboxCli implements MicrosandboxCli {
  private readonly command: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly nodeExecutable: string;

  constructor(opts: NodeMicrosandboxCliOptions = {}) {
    this.command = opts.command ?? DEFAULT_MICROSANDBOX_COMMAND;
    this.nodeExecutable = opts.nodeExecutable ?? process.execPath;
    this.env = microsandboxCliEnv(opts.env ?? process.env, {
      nodeExecutable: this.nodeExecutable,
    });
  }

  exec(
    args: readonly string[],
    opts: MicrosandboxCliExecOptions = {},
  ): Promise<MicrosandboxCliResult> {
    return execMicrosandboxCommand(this.command, args, {
      ...opts,
      env: microsandboxCliEnv(
        { ...this.env, ...opts.env },
        { nodeExecutable: this.nodeExecutable },
      ),
    });
  }

  execSync(
    args: readonly string[],
    opts: Omit<MicrosandboxCliExecOptions, "signal"> = {},
  ): MicrosandboxCliResult {
    return execMicrosandboxCommandSync(this.command, args, {
      ...opts,
      env: microsandboxCliEnv(
        { ...this.env, ...opts.env },
        { nodeExecutable: this.nodeExecutable },
      ),
    });
  }
}

export function microsandboxCliEnv(
  source: NodeJS.ProcessEnv = process.env,
  opts: { nodeExecutable?: string } = {},
): NodeJS.ProcessEnv {
  const nodeDir = dirname(opts.nodeExecutable ?? process.execPath);
  const path = source.PATH;
  const out: NodeJS.ProcessEnv = {};
  for (const key of MICROSANDBOX_ENV_ALLOWLIST) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  out.PATH =
    path === undefined || path.length === 0
      ? nodeDir
      : path.split(":").includes(nodeDir)
        ? path
        : `${nodeDir}:${path}`;
  return out;
}

export function buildMicrosandboxVolumeCreateArgs(volumeName: string): string[] {
  return ["volume", "create", "--name", volumeName];
}

export function buildMicrosandboxVolumeRemoveArgs(volumeName: string): string[] {
  return ["volume", "remove", volumeName];
}

export function buildMicrosandboxVolumeListArgs(): string[] {
  return ["volume", "list", "--format", "json"];
}

export function buildMicrosandboxVolumeInspectArgs(
  volumeName: string,
): string[] {
  return ["volume", "inspect", volumeName];
}

export function buildMicrosandboxCreateArgs(opts: {
  sandboxName: string;
  volumeName: string;
  image?: string;
  workspacePath?: string;
  workdir?: string;
  pullPolicy?: "always" | "if-missing" | "never";
  labels?: Readonly<Record<string, string>>;
}): string[] {
  const workspacePath = opts.workspacePath ?? DEFAULT_MICROSANDBOX_WORKSPACE;
  const labels = Object.entries(opts.labels ?? {}).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`,
  ]);
  return [
    "create",
    opts.image ?? DEFAULT_MICROSANDBOX_IMAGE,
    "--name",
    opts.sandboxName,
    "--mount-named",
    `${opts.volumeName}:${workspacePath}`,
    "--workdir",
    opts.workdir ?? workspacePath,
    "--no-net",
    "--pull",
    opts.pullPolicy ?? "if-missing",
    "--quiet",
    ...labels,
  ];
}

export function buildMicrosandboxExecArgs(opts: {
  sandboxName: string;
  command: readonly string[];
  workdir?: string;
  timeout?: string;
  stream?: boolean;
}): string[] {
  const out = ["exec"];
  if (opts.stream) out.push("--stream");
  if (opts.timeout !== undefined) out.push("--timeout", opts.timeout);
  if (opts.workdir !== undefined) out.push("--workdir", opts.workdir);
  out.push(opts.sandboxName, "--", ...opts.command);
  return out;
}

export function buildMicrosandboxShellExecArgs(opts: {
  sandboxName: string;
  script: string;
  args?: readonly string[];
  workdir?: string;
  timeout?: string;
  stream?: boolean;
}): string[] {
  return buildMicrosandboxExecArgs({
    sandboxName: opts.sandboxName,
    workdir: opts.workdir,
    timeout: opts.timeout,
    stream: opts.stream,
    command: ["/bin/sh", "-lc", opts.script, "sh", ...(opts.args ?? [])],
  });
}

export function buildMicrosandboxCopyArgs(
  source: string,
  destination: string,
): string[] {
  return ["copy", source, destination];
}

export function microsandboxPathRef(
  sandboxName: string,
  absolutePath: string,
): string {
  return `${sandboxName}:${absolutePath}`;
}

export function buildMicrosandboxStopArgs(sandboxName: string): string[] {
  return ["stop", sandboxName];
}

export function buildMicrosandboxStartArgs(sandboxName: string): string[] {
  return ["start", sandboxName];
}

export function buildMicrosandboxRemoveArgs(sandboxName: string): string[] {
  return ["remove", "--force", sandboxName];
}

export function buildMicrosandboxListArgs(
  labels: readonly string[] = [],
): string[] {
  return [
    "list",
    "--format",
    "json",
    ...labels.flatMap((label) => ["--label", label]),
  ];
}

export function buildMicrosandboxInspectArgs(sandboxName: string): string[] {
  return ["inspect", sandboxName, "--format", "json"];
}

export function microsandboxResourceName(opts: {
  prefix?: string;
  workspaceId: string;
  sessionId: string;
  purpose: string;
  now?: () => number;
  random?: () => number;
}): string {
  return [
    sanitizeMicrosandboxNamePart(opts.prefix ?? "oma"),
    sanitizeMicrosandboxNamePart(opts.workspaceId),
    sanitizeMicrosandboxNamePart(opts.sessionId),
    sanitizeMicrosandboxNamePart(opts.purpose),
    (opts.now?.() ?? Date.now()).toString(36),
    (opts.random?.() ?? Math.random()).toString(36).slice(2, 8),
  ].join("-");
}

export function execMicrosandboxCommand(
  command: string,
  args: readonly string[],
  opts: MicrosandboxCliExecOptions = {},
): Promise<MicrosandboxCliResult> {
  return new Promise((resolve, reject) => {
    const maxBuffer = opts.maxBuffer ?? DEFAULT_MICROSANDBOX_MAX_BUFFER;
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      signal: opts.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (result: MicrosandboxCliResult): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxBuffer) {
        fail(
          new Error(`Microsandbox command output exceeded ${maxBuffer} bytes`),
        );
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.on("error", fail);
    child.on("close", (status, signal) =>
      finish({
        status,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }),
    );
    try {
      if (opts.input !== undefined) child.stdin.end(opts.input);
      else child.stdin.end();
    } catch (error) {
      fail(error as Error);
    }
    if (opts.timeoutMs !== undefined) {
      timeout = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    }
  });
}

export function execMicrosandboxCommandSync(
  command: string,
  args: readonly string[],
  opts: Omit<MicrosandboxCliExecOptions, "signal"> = {},
): MicrosandboxCliResult {
  const result = spawnSync(command, [...args], {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    maxBuffer: opts.maxBuffer ?? DEFAULT_MICROSANDBOX_MAX_BUFFER,
    timeout: opts.timeoutMs,
    encoding: "buffer",
  });
  if (result.error) throw result.error;
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
    signal: result.signal,
  };
}

function sanitizeMicrosandboxNamePart(value: string): string {
  const sanitized = value.toLowerCase().replaceAll(/[^a-z0-9_.-]+/g, "-");
  return sanitized.replaceAll(/^-+|-+$/g, "") || "x";
}
