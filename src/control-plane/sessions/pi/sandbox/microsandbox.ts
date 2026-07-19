import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join as joinHostPath, posix } from "node:path";
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
  CMA_GLOB_READY_MARKER,
  CmaGlobReadinessFilter,
  CmaGlobStreamCollector,
  cmaGlobToRipgrepGlob,
  compileCmaGlob,
} from "./cma-glob.ts";
import {
  CMA_GREP_READY_MARKER,
  CmaGrepStreamCollector,
} from "./cma-grep.ts";
import { matchGlob } from "./glob.ts";
import {
  createSandboxInvocationStats,
  createSandboxToolDefinitions,
  recordSandboxInvocation,
  type CmaGlobOperations,
  type CmaGrepOperations,
  type SandboxDisposedFlag,
  type SandboxOperations,
  type SandboxOutputFile,
  type SandboxProvider,
  type SandboxProviderFactory,
} from "./provider.ts";
import type { RuntimeSessionFileMount } from "../../../events/types.ts";
import {
  MAX_SESSION_OUTPUT_BYTES,
  MAX_SESSION_OUTPUT_FILE_BYTES,
  MAX_SESSION_OUTPUT_FILES,
} from "../../../files/types.ts";
import { DEFAULT_OMA_SANDBOX_IMAGE } from "./image.ts";

export const DEFAULT_MICROSANDBOX_COMMAND = "msb";
export const DEFAULT_MICROSANDBOX_IMAGE = DEFAULT_OMA_SANDBOX_IMAGE;
export const DEFAULT_MICROSANDBOX_WORKSPACE = "/workspace";
export const DEFAULT_MICROSANDBOX_UPLOADS_PATH = "/mnt/session/uploads";
export const DEFAULT_MICROSANDBOX_OUTPUTS_PATH = "/mnt/session/outputs";
export const DEFAULT_MICROSANDBOX_MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_MICROSANDBOX_OPERATION_TIMEOUT_MS = 10_000;
export const DEFAULT_MICROSANDBOX_STARTUP_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MICROSANDBOX_CPUS = "1";
const DEFAULT_MICROSANDBOX_MEMORY = "1G";
const DEFAULT_MICROSANDBOX_OCI_UPPER_SIZE = "1G";
const DEFAULT_MICROSANDBOX_MAX_DURATION = "2h";
const DEFAULT_MICROSANDBOX_SECURITY = "restricted";
const DEFAULT_MICROSANDBOX_UPLOADS_TMPFS_SIZE = "64M";
const DEFAULT_MICROSANDBOX_OUTPUTS_TMPFS_SIZE = "100M";
const SANDBOX_LABEL_KEY = "open-managed-agents.sandbox";
const SANDBOX_LABEL_VALUE = "microsandbox-local";
const OWNER_LABEL_KEY = "open-managed-agents.owner";
const OWNER_LABEL_VALUE = "open-managed-agents";
const BASH_DISPATCH_PREFIX = "__OMA_DISPATCHED__:";
const BASH_TERMINAL_PREFIX = "__OMA_TERMINAL__:";

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
  onData?: (data: Buffer) => void;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBuffer?: number;
  guestTimeout?: boolean;
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

export interface MicrosandboxSandboxOptions {
  image?: string;
  cli?: MicrosandboxCli;
  command?: string;
  workspacePath?: string;
  operationTimeoutMs?: number;
  /** Bounded separately because a cold `msb create --pull if-missing` downloads the image. */
  startupTimeoutMs?: number;
  resourceNamePrefix?: string;
  cpus?: string;
  memory?: string;
  ociUpperSize?: string;
  maxDuration?: string;
  security?: "default" | "restricted";
  maxOutputFiles?: number;
  maxOutputFileBytes?: number;
  maxOutputBytes?: number;
  reapStaleSandboxesOlderThanMs?: number;
  now?: () => number;
  random?: () => number;
  /** 0121 C2 telemetry: startup sweep reported reaping N stale sandboxes. */
  onReaped?: (count: number) => void;
}

export interface MicrosandboxSandboxReaperOptions {
  cli?: MicrosandboxCli;
  command?: string;
  olderThanMs: number;
  labelFilters?: string[];
  resourceNamePrefix?: string;
  now?: () => number;
}

interface MicrosandboxResolvedOptions {
  image: string;
  cli: MicrosandboxCli;
  workspacePath: string;
  uploadsPath: string;
  outputsPath: string;
  operationTimeoutMs: number;
  startupTimeoutMs: number;
  resourceNamePrefix: string;
  cpus: string;
  memory: string;
  ociUpperSize: string;
  maxDuration: string;
  security: "default" | "restricted";
  maxOutputFiles: number;
  maxOutputFileBytes: number;
  maxOutputBytes: number;
  now?: () => number;
  random?: () => number;
}

export interface MicrosandboxShellCommand {
  script: string;
  args: readonly string[];
  input?: Buffer | string;
}

export interface MicrosandboxExecResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
}

type BashTerminalRecord =
  | { kind: "exit"; exitCode: number }
  | { kind: "timeout"; exitCode: number };

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

export function createMicrosandboxSandboxProviderFactory(
  opts: MicrosandboxSandboxOptions = {},
): SandboxProviderFactory {
  const cli =
    opts.cli ??
    new NodeMicrosandboxCli({
      command: opts.command ?? DEFAULT_MICROSANDBOX_COMMAND,
    });
  const providerOpts = { ...opts, cli };
  let swept = false;
  let sweepPromise: Promise<void> | undefined;
  return async (workspaceId, sessionId) => {
    if (!swept && opts.reapStaleSandboxesOlderThanMs !== undefined) {
      sweepPromise ??= reapMicrosandboxSandboxes({
        cli,
        olderThanMs: opts.reapStaleSandboxesOlderThanMs,
        resourceNamePrefix: opts.resourceNamePrefix,
        now: opts.now,
      }).then(
        (count) => {
          if (count > 0) opts.onReaped?.(count);
          swept = true;
        },
        (error: unknown) => {
          sweepPromise = undefined;
          throw error;
        },
      );
      await sweepPromise;
    }
    return createMicrosandboxSandboxProvider(workspaceId, sessionId, providerOpts);
  };
}

export async function createMicrosandboxSandboxProvider(
  workspaceId: string,
  sessionId: string,
  opts: MicrosandboxSandboxOptions = {},
): Promise<SandboxProvider> {
  const resolved = resolveMicrosandboxOptions(opts);
  const sandboxName = microsandboxResourceName({
    prefix: resolved.resourceNamePrefix,
    workspaceId,
    sessionId,
    purpose: "sandbox",
    now: resolved.now,
    random: resolved.random,
  });
  const volumeName = microsandboxResourceName({
    prefix: resolved.resourceNamePrefix,
    workspaceId,
    sessionId,
    purpose: "workspace-volume",
    now: resolved.now,
    random: resolved.random,
  });
  let volumeCreated = false;
  let sandboxCreated = false;
  try {
    await microsandboxChecked(
      resolved.cli,
      buildMicrosandboxVolumeCreateArgs(volumeName),
      { timeoutMs: resolved.operationTimeoutMs },
    );
    volumeCreated = true;
    await microsandboxChecked(
      resolved.cli,
      buildMicrosandboxCreateArgs({
        sandboxName,
        volumeName,
        image: resolved.image,
        workspacePath: resolved.workspacePath,
        workdir: resolved.workspacePath,
        cpus: resolved.cpus,
        memory: resolved.memory,
        ociUpperSize: resolved.ociUpperSize,
        maxDuration: resolved.maxDuration,
        security: resolved.security,
        labels: {
          [SANDBOX_LABEL_KEY]: SANDBOX_LABEL_VALUE,
          [OWNER_LABEL_KEY]: OWNER_LABEL_VALUE,
          "open-managed-agents.workspace-id": workspaceId,
          "open-managed-agents.session-id": sessionId,
          "open-managed-agents.created-at": new Date(
            resolved.now?.() ?? Date.now(),
          ).toISOString(),
        },
      }),
      { timeoutMs: resolved.startupTimeoutMs },
    );
    sandboxCreated = true;
    await microsandboxChecked(
      resolved.cli,
      buildMicrosandboxShellExecArgs({
        sandboxName,
        ...buildMicrosandboxPrepareMountsCommand(
          resolved.uploadsPath,
          resolved.outputsPath,
        ),
        workdir: resolved.workspacePath,
        timeout: timeoutSecondsText(resolved.operationTimeoutMs),
        user: "0",
      }),
      { timeoutMs: resolved.operationTimeoutMs + 2_000 },
    );
  } catch (error) {
    if (volumeCreated || sandboxCreated) {
      forceRemoveMicrosandboxSandbox(resolved.cli, sandboxName, resolved);
    }
    if (volumeCreated) {
      forceRemoveMicrosandboxVolume(resolved.cli, volumeName, resolved);
    }
    throw error;
  }

  const invocations = createSandboxInvocationStats();
  const disposed: SandboxDisposedFlag = { value: false };
  let disposeAttempted = false;
  let poisoned = false;
  let poisonPromise: Promise<void> | undefined;
  const disposeInfrastructure = (): void => {
    if (disposeAttempted) return;
    disposeAttempted = true;
    disposed.value = true;
    forceRemoveMicrosandboxSandbox(resolved.cli, sandboxName, resolved);
    forceRemoveMicrosandboxVolume(resolved.cli, volumeName, resolved);
  };
  const poisonInfrastructure = (): Promise<void> => {
    poisoned = true;
    disposed.value = true;
    if (poisonPromise) return poisonPromise;
    poisonPromise = (async () => {
      await removeMicrosandboxSandboxChecked(
        resolved.cli,
        sandboxName,
        resolved.operationTimeoutMs,
      );
      disposeAttempted = true;
      forceRemoveMicrosandboxVolume(resolved.cli, volumeName, resolved);
    })();
    return poisonPromise;
  };

  const shell = (
    command: MicrosandboxShellCommand,
    execOpts: MicrosandboxCliExecOptions = {},
    guestUser?: string,
  ) =>
    microsandboxChecked(
      resolved.cli,
      buildMicrosandboxShellExecArgs({
        sandboxName,
        script: command.script,
        args: command.args,
        workdir: resolved.workspacePath,
        timeout: execOpts.guestTimeout === false
          ? undefined
          : timeoutSecondsText(execOpts.timeoutMs ?? resolved.operationTimeoutMs),
        stream:
          command.input !== undefined ||
          execOpts.input !== undefined ||
          execOpts.onData !== undefined ||
          execOpts.onStdout !== undefined ||
          execOpts.onStderr !== undefined,
        user: guestUser,
      }),
      {
        ...execOpts,
        input: execOpts.input ?? command.input,
        timeoutMs:
          (execOpts.timeoutMs ?? resolved.operationTimeoutMs) + 2_000,
      },
    );
  const exists = async (absolutePath: string): Promise<boolean> => {
    const result = await resolved.cli.exec(
      buildMicrosandboxShellExecArgs({
        sandboxName,
        script: "test -e \"$1\"",
        args: [absolutePath],
        workdir: resolved.workspacePath,
        timeout: timeoutSecondsText(resolved.operationTimeoutMs),
      }),
      { timeoutMs: resolved.operationTimeoutMs + 2_000 },
    );
    if (result.signal !== null) throw new Error("microsandbox exists timed out");
    if (result.status === 0) return true;
    if (result.status === 1 && result.stderr.length === 0) return false;
    throw new Error(
      `msb exists failed with ${result.status}: ${errorText(result)}`,
    );
  };
  await shell(buildMicrosandboxCmaGrepPreflightCommand(), {
    timeoutMs: 3_000,
    guestTimeout: false,
  });
  const materializeFileResources = async (
    mounts: readonly RuntimeSessionFileMount[],
  ): Promise<void> => {
    if (mounts.length === 0) return;
    recordSandboxNotDisposed(disposed);
    for (const kind of ["upload", "skill"] as const) {
      const selected = mounts.filter((mount) => mount.kind === kind);
      if (selected.length === 0) continue;
      const destination = kind === "upload" ? resolved.uploadsPath : "/workspace/skills";
      const tempRoot = await mkdtemp(joinHostPath(tmpdir(), "oma-msb-mounts-"));
      try {
        for (const mount of selected) {
          const relativePath = assertInsideMicrosandboxUploadsPath(
            mount.mountPath,
            destination,
          );
          const hostPath = await writeMountFile(tempRoot, relativePath, mount);
          const guestPath = posix.join(destination, relativePath);
          await shell(
            buildMicrosandboxMkdirCommand(posix.dirname(guestPath)),
            {},
            "0",
          );
          await microsandboxChecked(
            resolved.cli,
            buildMicrosandboxCopyArgs(
              hostPath,
              microsandboxPathRef(sandboxName, guestPath),
            ),
            { timeoutMs: resolved.operationTimeoutMs },
          );
        }
        await shell(
          kind === "upload"
            ? buildMicrosandboxNormalizeUploadsCommand(destination)
            : buildMicrosandboxNormalizeSkillsCommand(destination),
          {},
          "0",
        );
      } finally {
        await rm(tempRoot, { force: true, recursive: true });
      }
    }
  };
  const collectOutputFiles = async (): Promise<readonly SandboxOutputFile[]> => {
    recordSandboxNotDisposed(disposed);
    const listing = await shell(
      buildMicrosandboxOutputListingCommand(resolved.outputsPath, {
        maxFiles: resolved.maxOutputFiles,
        maxFileBytes: resolved.maxOutputFileBytes,
        maxBytes: resolved.maxOutputBytes,
      }),
    );
    const records = parseOutputListing(listing.stdout);
    return records.map((record) => {
      const absolutePath = assertInsideMicrosandboxOutputPath(
        posix.join(resolved.outputsPath, record.relativePath),
        resolved.outputsPath,
      );
      return {
        relativePath: record.relativePath,
        filename: posix.basename(record.relativePath),
        mimeType: mimeTypeForFilename(record.relativePath),
        sizeBytes: record.sizeBytes,
        sha256: record.sha256,
        bytes: microsandboxOutputBytes(() =>
          shell(buildMicrosandboxReadFileCommand(absolutePath), {
            maxBuffer: resolved.maxOutputFileBytes,
          }),
        ),
      };
    });
  };

  const readOps: ReadOperations = {
    access: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "read");
      await shell(
        buildMicrosandboxFileAccessCommand(
          assertInsideMicrosandboxWorkspace(
            absolutePath,
            resolved.workspacePath,
          ),
          "read",
        ),
      );
    },
    readFile: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "read");
      return (
        await shell(
          buildMicrosandboxReadFileCommand(
            assertInsideMicrosandboxWorkspace(
              absolutePath,
              resolved.workspacePath,
            ),
          ),
        )
      ).stdout;
    },
  };
  const writeOps: WriteOperations = {
    mkdir: async (dir) => {
      recordSandboxInvocation(invocations, disposed, "write");
      await shell(
        buildMicrosandboxMkdirCommand(
          assertInsideMicrosandboxWorkspace(dir, resolved.workspacePath),
        ),
      );
    },
    writeFile: async (absolutePath, content) => {
      recordSandboxInvocation(invocations, disposed, "write");
      await shell(
        buildMicrosandboxWriteFileCommand(
          assertInsideMicrosandboxWorkspace(
            absolutePath,
            resolved.workspacePath,
          ),
          content,
        ),
      );
    },
  };
  const editOps: EditOperations = {
    access: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "edit");
      await shell(
        buildMicrosandboxFileAccessCommand(
          assertInsideMicrosandboxWorkspace(
            absolutePath,
            resolved.workspacePath,
          ),
          "edit",
        ),
      );
    },
    readFile: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "edit");
      return (
        await shell(
          buildMicrosandboxReadFileCommand(
            assertInsideMicrosandboxWorkspace(
              absolutePath,
              resolved.workspacePath,
            ),
          ),
        )
      ).stdout;
    },
    writeFile: async (absolutePath, content) => {
      recordSandboxInvocation(invocations, disposed, "edit");
      await shell(
        buildMicrosandboxWriteFileCommand(
          assertInsideMicrosandboxWorkspace(
            absolutePath,
            resolved.workspacePath,
          ),
          content,
        ),
      );
    },
  };
  const findOps: FindOperations = {
    exists: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "find");
      return exists(
        assertInsideMicrosandboxWorkspace(absolutePath, resolved.workspacePath),
      );
    },
    glob: async (pattern, cwd, options) => {
      recordSandboxInvocation(invocations, disposed, "find");
      const root = assertInsideMicrosandboxWorkspace(
        cwd,
        resolved.workspacePath,
      );
      const result = await shell(
        buildMicrosandboxGlobEnumerationCommand(root, options.ignore),
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
  const globOps: CmaGlobOperations = {
    glob: async ({ pattern, cwd, signal, maxMatches, maxRawBytes, maxOutputBytes, outputBase, timeoutMs }) => {
      recordSandboxInvocation(invocations, disposed, "glob");
      const root = assertInsideMicrosandboxWorkspace(cwd, resolved.workspacePath);
      if (signal.aborted) throw new Error("Operation aborted");
      const controller = new AbortController();
      const ownershipToken = `oma-glob-${randomUUID()}`;
      const protocolBytes = Buffer.byteLength(CMA_GLOB_READY_MARKER, "utf8") + 1;
      const abortFromCaller = () => controller.abort();
      signal.addEventListener("abort", abortFromCaller, { once: true });
      let streamError: Error | undefined;
      let sawStdout = false;
      const readiness = new CmaGlobReadinessFilter(CMA_GLOB_READY_MARKER);
      const collector = new CmaGlobStreamCollector(compileCmaGlob(pattern), {
        root,
        maxMatches,
        maxRawBytes,
        maxOutputBytes,
        join: posix.join,
        formatForOutput: outputBase === undefined
          ? undefined
          : (absolutePath) => posix.relative(outputBase, absolutePath),
        onLimit: () => controller.abort(),
      });
      try {
        const result = await shell(
          buildMicrosandboxCmaGlobEnumerationCommand(root, ownershipToken),
          {
          signal: controller.signal,
          timeoutMs,
          guestTimeout: false,
          maxBuffer: maxRawBytes + protocolBytes + 64 * 1024,
          onStdout: (chunk) => {
            sawStdout = true;
            try {
              const filenames = readiness.push(chunk);
              if (filenames) collector.push(filenames);
            } catch (error) {
              streamError = error as Error;
              controller.abort();
            }
          },
          },
        );
        // Test/custom CLI implementations may return buffered stdout without
        // invoking the optional streaming callback.
        if (!sawStdout && result.stdout.length > 0) {
          const filenames = readiness.push(result.stdout);
          if (filenames) collector.push(filenames);
        }
        if (streamError) throw streamError;
        if (signal.aborted) throw new Error("Operation aborted");
        readiness.assertReady();
        collector.finish();
      } catch (error) {
        if (streamError) throw streamError;
        if (signal.aborted) throw new Error("Operation aborted");
        if (!collector.limitReached) throw error;
      } finally {
        try {
          if (!readiness.ready) {
            await poisonInfrastructure();
          } else {
            try {
              await shell(
                buildMicrosandboxCmaGlobCleanupCommand(ownershipToken),
                {
                  timeoutMs: 3_000,
                  guestTimeout: false,
                },
              );
            } catch (cleanupError) {
              await poisonInfrastructure();
              throw cleanupError;
            }
          }
        } finally {
          signal.removeEventListener("abort", abortFromCaller);
        }
      }
      if (signal.aborted) throw new Error("Operation aborted");
      return collector.matches;
    },
  };
  const grepOps: CmaGrepOperations = {
    grep: async ({ pattern, cwd, signal, glob, headLimit, maxRawBytes, maxOutputBytes, outputBase, timeoutMs }) => {
      recordSandboxInvocation(invocations, disposed, "grep");
      const root = assertInsideMicrosandboxSearchRoot(cwd, [
        resolved.workspacePath,
        resolved.uploadsPath,
        "/workspace/skills",
      ]);
      if (signal.aborted) throw new Error("Operation aborted");
      const controller = new AbortController();
      const protocolBytes = Buffer.byteLength(CMA_GREP_READY_MARKER, "utf8") + 1;
      const abortFromCaller = () => controller.abort();
      signal.addEventListener("abort", abortFromCaller, { once: true });
      let streamError: Error | undefined;
      let sawStdout = false;
      const ownershipToken = `oma-grep-${randomUUID()}`;
      const readiness = new CmaGlobReadinessFilter(CMA_GREP_READY_MARKER);
      const collector = new CmaGrepStreamCollector({
        root,
        maxMatches: headLimit,
        maxRawBytes,
        maxOutputBytes,
        join: posix.join,
        formatForOutput: outputBase === undefined
          ? undefined
          : (absolutePath) => posix.relative(outputBase, absolutePath),
        onLimit: () => controller.abort(),
      });
      try {
        try {
          const result = await shell(
            buildMicrosandboxCmaGrepSearchCommand(root, ownershipToken, pattern, glob),
            {
              signal: controller.signal,
              timeoutMs,
              guestTimeout: false,
              maxBuffer: maxRawBytes + protocolBytes + 64 * 1024,
              onStdout: (chunk) => {
                sawStdout = true;
                try {
                  const filenames = readiness.push(chunk);
                  if (filenames) collector.push(filenames);
                } catch (error) {
                  streamError = error as Error;
                  controller.abort();
                }
              },
            },
          );
          if (!sawStdout && result.stdout.length > 0) {
            const filenames = readiness.push(result.stdout);
            if (filenames) collector.push(filenames);
          }
          if (streamError) throw streamError;
          if (signal.aborted) throw new Error("Operation aborted");
          readiness.assertReady();
          collector.finish();
        } catch (error) {
          if (streamError) throw streamError;
          if (signal.aborted) throw new Error("Operation aborted");
          if (!collector.limitReached) throw error;
        } finally {
          if (!readiness.ready) {
            await poisonInfrastructure();
          } else {
            try {
              await shell(
                buildMicrosandboxCmaGrepCleanupCommand(ownershipToken),
                {
                  timeoutMs: 3_000,
                  guestTimeout: false,
                },
              );
            } catch (cleanupError) {
              await poisonInfrastructure();
              throw cleanupError;
            }
          }
        }
        if (signal.aborted) throw new Error("Operation aborted");
        return collector.matches;
      } finally {
        signal.removeEventListener("abort", abortFromCaller);
      }
    },
  };
  const lsOps: LsOperations = {
    exists: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "ls");
      return exists(
        assertInsideMicrosandboxWorkspace(absolutePath, resolved.workspacePath),
      );
    },
    stat: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "ls");
      const result = await shell(
        buildMicrosandboxStatCommand(
          assertInsideMicrosandboxWorkspace(
            absolutePath,
            resolved.workspacePath,
          ),
        ),
      );
      const kind = result.stdout.toString("utf8");
      return { isDirectory: () => kind === "directory" };
    },
    readdir: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "ls");
      const result = await shell(
        buildMicrosandboxReaddirCommand(
          assertInsideMicrosandboxWorkspace(
            absolutePath,
            resolved.workspacePath,
          ),
        ),
      );
      return result.stdout.toString("utf8").split("\n").filter(Boolean);
    },
  };
  const bashOps: BashOperations = {
    exec: async (command, cwd, options) => {
      recordSandboxInvocation(invocations, disposed, "bash");
      const path = assertInsideMicrosandboxWorkspace(
        cwd,
        resolved.workspacePath,
      );
      const timeoutSeconds =
        options.timeout !== undefined && options.timeout > 0
          ? options.timeout
          : resolved.operationTimeoutMs / 1000;
      const execId = randomExecId();
      const dispatchToken = randomExecId();
      const pidFile = posix.join(
        resolved.workspacePath,
        `.oma-msb-exec-${execId}.pid`,
      );
      const shellCommand = buildMicrosandboxBashCommand(
        command,
        timeoutSeconds,
        pidFile,
        dispatchToken,
      );
      const dispatchFilter = createMicrosandboxBashDispatchFilter(dispatchToken);
      try {
        const result = await resolved.cli.exec(
          buildMicrosandboxShellExecArgs({
            sandboxName,
            script: shellCommand.script,
            args: shellCommand.args,
            workdir: path,
            stream: true,
          }),
          {
            onData: (chunk) => {
              const forwarded = dispatchFilter.chunk(chunk);
              if (forwarded.length > 0) options.onData(forwarded);
            },
            signal: options.signal,
            timeoutMs: Math.ceil(timeoutSeconds * 1000) + 2_000,
          },
        );
        if (result.signal !== null) {
          killMicrosandboxGuestProcessGroup(
            resolved.cli,
            sandboxName,
            pidFile,
            resolved,
          );
          throw new Error(`timeout:${timeoutSeconds}`);
        }
        if (!dispatchFilter.dispatchSeen()) {
          throw new Error("microsandbox bash failed before command dispatch");
        }
        const terminal = dispatchFilter.terminalRecord();
        if (terminal === undefined) {
          throw new Error("microsandbox bash failed before command completion");
        }
        if (
          result.status !==
          (terminal.kind === "timeout" ? 137 : terminal.exitCode)
        ) {
          throw new Error(
            "microsandbox bash exit disagreed with command completion",
          );
        }
        if (terminal.kind === "timeout") {
          throw new Error(`timeout:${timeoutSeconds}`);
        }
        return { exitCode: terminal.exitCode };
      } catch (error) {
        if (isAbortError(error) || isMicrosandboxOutputOverflow(error)) {
          killMicrosandboxGuestProcessGroup(
            resolved.cli,
            sandboxName,
            pidFile,
            resolved,
          );
          if (isAbortError(error)) throw new Error("aborted");
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
    glob: globOps,
    grep: grepOps,
    ls: lsOps,
  };

  return {
    cwd: resolved.workspacePath,
    collectOutputFiles,
    invocations,
    materializeFileResources,
    operations,
    toolNames: new Set(["bash", "read", "write", "edit", "glob", "grep", "ls"]),
    tools: createSandboxToolDefinitions(
      resolved.workspacePath,
      operations,
      invocations,
      disposed,
    ),
    isPoisoned: () => poisoned,
    dispose: disposeInfrastructure,
  };
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
  assertMicrosandboxArg(volumeName, "volumeName");
  return ["volume", "create", "--name", volumeName];
}

export function buildMicrosandboxVolumeRemoveArgs(volumeName: string): string[] {
  assertMicrosandboxArg(volumeName, "volumeName");
  return ["volume", "remove", volumeName];
}

export function buildMicrosandboxVolumeListArgs(): string[] {
  return ["volume", "list", "--format", "json"];
}

export function buildMicrosandboxVolumeInspectArgs(
  volumeName: string,
): string[] {
  assertMicrosandboxArg(volumeName, "volumeName");
  return ["volume", "inspect", volumeName];
}

export function buildMicrosandboxCreateArgs(opts: {
  sandboxName: string;
  volumeName: string;
  image?: string;
  workspacePath?: string;
  workdir?: string;
  pullPolicy?: "always" | "if-missing" | "never";
  cpus?: string;
  memory?: string;
  ociUpperSize?: string;
  maxDuration?: string;
  security?: "default" | "restricted";
  labels?: Readonly<Record<string, string>>;
}): string[] {
  const workspacePath = opts.workspacePath ?? DEFAULT_MICROSANDBOX_WORKSPACE;
  assertMicrosandboxArg(opts.sandboxName, "sandboxName");
  assertMicrosandboxArg(opts.volumeName, "volumeName");
  assertMicrosandboxArg(opts.image ?? DEFAULT_MICROSANDBOX_IMAGE, "image");
  const labels = Object.entries(opts.labels ?? {}).flatMap(([key, value]) => [
    "--label",
    microsandboxLabelArg(key, value),
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
    "--tmpfs",
    `${DEFAULT_MICROSANDBOX_UPLOADS_PATH}:${DEFAULT_MICROSANDBOX_UPLOADS_TMPFS_SIZE}:nosuid,nodev,noexec`,
    "--tmpfs",
    `${DEFAULT_MICROSANDBOX_OUTPUTS_PATH}:${DEFAULT_MICROSANDBOX_OUTPUTS_TMPFS_SIZE}:nosuid,nodev,noexec`,
    "--cpus",
    opts.cpus ?? DEFAULT_MICROSANDBOX_CPUS,
    "--memory",
    opts.memory ?? DEFAULT_MICROSANDBOX_MEMORY,
    "--oci-upper-size",
    opts.ociUpperSize ?? DEFAULT_MICROSANDBOX_OCI_UPPER_SIZE,
    "--max-duration",
    opts.maxDuration ?? DEFAULT_MICROSANDBOX_MAX_DURATION,
    "--security",
    opts.security ?? DEFAULT_MICROSANDBOX_SECURITY,
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
  user?: string;
}): string[] {
  assertMicrosandboxArg(opts.sandboxName, "sandboxName");
  const out = ["exec"];
  if (opts.stream) out.push("--stream");
  if (opts.user !== undefined) {
    assertMicrosandboxArg(opts.user, "user");
    out.push("--user", opts.user);
  }
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
  user?: string;
}): string[] {
  return buildMicrosandboxExecArgs({
    sandboxName: opts.sandboxName,
    workdir: opts.workdir,
    timeout: opts.timeout,
    stream: opts.stream,
    user: opts.user,
    command: ["/bin/bash", "-lc", opts.script, "bash", ...(opts.args ?? [])],
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
  assertMicrosandboxArg(sandboxName, "sandboxName");
  return `${sandboxName}:${absolutePath}`;
}

export function buildMicrosandboxStopArgs(sandboxName: string): string[] {
  assertMicrosandboxArg(sandboxName, "sandboxName");
  return ["stop", sandboxName];
}

export function buildMicrosandboxStartArgs(sandboxName: string): string[] {
  assertMicrosandboxArg(sandboxName, "sandboxName");
  return ["start", sandboxName];
}

export function buildMicrosandboxRemoveArgs(sandboxName: string): string[] {
  assertMicrosandboxArg(sandboxName, "sandboxName");
  return ["remove", "--force", sandboxName];
}

export function buildMicrosandboxListArgs(
  labels: readonly string[] = [],
): string[] {
  return [
    "list",
    "--format",
    "json",
    ...labels.flatMap((label) => ["--label", microsandboxLabelFilterArg(label)]),
  ];
}

export function buildMicrosandboxInspectArgs(sandboxName: string): string[] {
  assertMicrosandboxArg(sandboxName, "sandboxName");
  return ["inspect", sandboxName, "--format", "json"];
}

export function buildMicrosandboxFileAccessCommand(
  absolutePath: string,
  mode: "read" | "edit",
): MicrosandboxShellCommand {
  return {
    script:
      mode === "read"
        ? "test -r \"$1\" -a -f \"$1\""
        : "test -r \"$1\" -a -w \"$1\" -a -f \"$1\"",
    args: [absolutePath],
  };
}

export function buildMicrosandboxReadFileCommand(
  absolutePath: string,
): MicrosandboxShellCommand {
  return { script: "cat \"$1\"", args: [absolutePath] };
}

export function buildMicrosandboxWriteFileCommand(
  absolutePath: string,
  content: Buffer | string,
): MicrosandboxShellCommand {
  return {
    script: "cat > \"$1\"",
    args: [absolutePath],
    input: content,
  };
}

export function buildMicrosandboxMkdirCommand(
  absolutePath: string,
): MicrosandboxShellCommand {
  return { script: "mkdir -p \"$1\"", args: [absolutePath] };
}

export function buildMicrosandboxPrepareMountsCommand(
  uploadsPath: string,
  outputsPath: string,
): MicrosandboxShellCommand {
  return {
    script:
      "chown 0:0 \"$1\" && chmod 755 \"$1\" && chown 65534:65534 \"$2\" && chmod 700 \"$2\"",
    args: [uploadsPath, outputsPath],
  };
}

export function buildMicrosandboxNormalizeUploadsCommand(
  uploadsPath: string,
): MicrosandboxShellCommand {
  return {
    script:
      "find \"$1\" -type d -exec chmod 755 {} + && find \"$1\" -type f -exec chmod 444 {} +",
    args: [uploadsPath],
  };
}

export function buildMicrosandboxNormalizeSkillsCommand(skillsPath: string): MicrosandboxShellCommand {
  return { script: "find \"$1\" -type d -exec chmod 755 {} + && find \"$1\" -type f -exec chmod 444 {} + && find \"$1\" -path '*/scripts/*' -type f -exec chmod 555 {} +", args: [skillsPath] };
}

export function buildMicrosandboxStatCommand(
  absolutePath: string,
): MicrosandboxShellCommand {
  return {
    script:
      "if [ -d \"$1\" ]; then printf directory; elif [ -e \"$1\" ]; then printf file; else exit 1; fi",
    args: [absolutePath],
  };
}

export function buildMicrosandboxReaddirCommand(
  absolutePath: string,
): MicrosandboxShellCommand {
  return { script: "ls -1A \"$1\"", args: [absolutePath] };
}

export function buildMicrosandboxCmaGlobCleanupCommand(
  ownershipToken: string,
): MicrosandboxShellCommand {
  return {
    script: [
      "pids=''",
      "for f in /proc/[0-9]*/environ; do",
      "  pid=${f#/proc/}; pid=${pid%/environ}",
      "  if tr '\\0' '\\n' < \"$f\" 2>/dev/null | grep -Fqx \"OMA_GLOB_OWNER=$1\"; then",
      "    start=$(awk '{print $22}' \"/proc/$pid/stat\" 2>/dev/null || true)",
      "    case \"$start\" in ''|*[!0-9]*) :;; *) pids=\"$pids $pid:$start\";; esac",
      "  fi",
      "done",
      "for entry in $pids; do",
      "  pid=${entry%%:*}; start=${entry#*:}",
      "  current=$(awk '{print $22}' \"/proc/$pid/stat\" 2>/dev/null || true)",
      "  if [ \"$current\" = \"$start\" ] && tr '\\0' '\\n' < \"/proc/$pid/environ\" 2>/dev/null | grep -Fqx \"OMA_GLOB_OWNER=$1\"; then",
      "    kill -KILL \"-$pid\" 2>/dev/null || kill -KILL \"$pid\" 2>/dev/null || true",
      "  fi",
      "done",
      "attempt=0",
      "while [ -n \"$pids\" ] && [ \"$attempt\" -lt 40 ]; do",
      "  remaining=''",
      "  for entry in $pids; do",
      "    pid=${entry%%:*}; start=${entry#*:}",
      "    current=$(awk '{print $22}' \"/proc/$pid/stat\" 2>/dev/null || true)",
      "    if [ \"$current\" = \"$start\" ] && tr '\\0' '\\n' < \"/proc/$pid/environ\" 2>/dev/null | grep -Fqx \"OMA_GLOB_OWNER=$1\"; then remaining=\"$remaining $entry\"; fi",
      "  done",
      "  pids=$remaining",
      "  [ -z \"$pids\" ] && break",
      "  attempt=$((attempt + 1)); sleep 0.05",
      "done",
      "[ -z \"$pids\" ]",
    ].join("\n"),
    args: [ownershipToken],
  };
}

export function buildMicrosandboxCmaGrepCleanupCommand(
  ownershipToken: string,
): MicrosandboxShellCommand {
  return {
    script: [
      "pids=''",
      "for f in /proc/[0-9]*/environ; do",
      "  pid=${f#/proc/}; pid=${pid%/environ}",
      "  if tr '\\0' '\\n' < \"$f\" 2>/dev/null | grep -Fqx \"OMA_GREP_OWNER=$1\"; then",
      "    start=$(awk '{print $22}' \"/proc/$pid/stat\" 2>/dev/null || true)",
      "    case \"$start\" in ''|*[!0-9]*) :;; *) pids=\"$pids $pid:$start\";; esac",
      "  fi",
      "done",
      "for entry in $pids; do",
      "  pid=${entry%%:*}; start=${entry#*:}",
      "  current=$(awk '{print $22}' \"/proc/$pid/stat\" 2>/dev/null || true)",
      "  if [ \"$current\" = \"$start\" ] && tr '\\0' '\\n' < \"/proc/$pid/environ\" 2>/dev/null | grep -Fqx \"OMA_GREP_OWNER=$1\"; then",
      "    kill -KILL \"-$pid\" 2>/dev/null || kill -KILL \"$pid\" 2>/dev/null || true",
      "  fi",
      "done",
      "attempt=0",
      "while [ -n \"$pids\" ] && [ \"$attempt\" -lt 40 ]; do",
      "  remaining=''",
      "  for entry in $pids; do",
      "    pid=${entry%%:*}; start=${entry#*:}",
      "    current=$(awk '{print $22}' \"/proc/$pid/stat\" 2>/dev/null || true)",
      "    if [ \"$current\" = \"$start\" ] && tr '\\0' '\\n' < \"/proc/$pid/environ\" 2>/dev/null | grep -Fqx \"OMA_GREP_OWNER=$1\"; then remaining=\"$remaining $entry\"; fi",
      "  done",
      "  pids=$remaining",
      "  [ -z \"$pids\" ] && break",
      "  attempt=$((attempt + 1)); sleep 0.05",
      "done",
      "[ -z \"$pids\" ]",
    ].join("\n"),
    args: [ownershipToken],
  };
}

export function buildMicrosandboxCmaGrepPreflightCommand(): MicrosandboxShellCommand {
  return {
    script: [
      "set -eu",
      "dir=\".oma-grep-preflight-$$\"",
      "mkdir \"$dir\"",
      "trap 'rm -rf \"$dir\"' EXIT",
      "printf 'needle\\n' > \"$dir/text.txt\"",
      "printf 'other\\n' > \"$dir/no-match.txt\"",
      "printf '\\0needle\\0tail' > \"$dir/binary.bin\"",
      "LC_ALL=C rg --no-config --files-with-matches --null -- 'needle' \"$dir/text.txt\" | grep -Fq \"$dir/text.txt\"",
      "set +e",
      "LC_ALL=C rg --no-config --files-with-matches --null -- 'needle' \"$dir/no-match.txt\" >/dev/null 2>&1",
      "code=$?",
      "set -e",
      "[ \"$code\" -eq 1 ]",
      "set +e",
      "LC_ALL=C rg --no-config --files-with-matches --null -- '[' \"$dir/text.txt\" >/dev/null 2>&1",
      "code=$?",
      "set -e",
      "[ \"$code\" -ne 0 ] && [ \"$code\" -ne 1 ]",
      "last=$(LC_ALL=C rg --no-config --files-with-matches --null -- 'needle' \"$dir/text.txt\" | tail -c 1 | od -An -tu1)",
      "[ \"$(printf '%s' \"$last\" | tr -d ' ')\" = 0 ]",
      "LC_ALL=C rg --no-config -qaU -- '\\x00' \"$dir/binary.bin\"",
      "set +e",
      "LC_ALL=C rg --no-config -qaU -- '\\x00' \"$dir/text.txt\"",
      "code=$?",
      "set -e",
      "[ \"$code\" -eq 1 ]",
    ].join("\n"),
    args: [],
  };
}

export function buildMicrosandboxCmaGrepSearchCommand(
  root: string,
  ownershipToken: string,
  pattern: string,
  glob?: string,
): MicrosandboxShellCommand {
  const ripgrepGlob = glob === undefined ? "" : cmaGlobToRipgrepGlob(glob);
  return {
    script: [
      "set -eu",
      "exec setsid env \"OMA_GREP_OWNER=$2\" bash -c '",
      "set -euo pipefail",
      "printf \"%s\\0\" __OMA_GREP_READY__",
      "emit_text_matches() {",
      "  while IFS= read -r -d \"\" path; do",
      "    set +e",
      "    LC_ALL=C rg --no-config -qaU -- \"\\x00\" \"$path\"",
      "    binary_code=$?",
      "    set -e",
      "    if [ \"$binary_code\" -eq 1 ]; then printf \"%s\\0\" \"$path\"; elif [ \"$binary_code\" -ne 0 ]; then exit \"$binary_code\"; fi",
      "  done",
      "}",
      "set +e",
      "if [ -n \"$3\" ]; then",
      "  LC_ALL=C rg --no-config --hidden --no-ignore --color never --files-with-matches --null --glob \"$3\" -- \"$2\" \"$1\" | emit_text_matches",
      "else",
      "  LC_ALL=C rg --no-config --hidden --no-ignore --color never --files-with-matches --null -- \"$2\" \"$1\" | emit_text_matches",
      "fi",
      "code=$?",
      "[ \"$code\" -eq 0 ] || [ \"$code\" -eq 1 ]",
      "' oma-rg \"$1\" \"$3\" \"$4\"",
    ].join("\n"),
    args: [root, ownershipToken, pattern, ripgrepGlob],
  };
}

export function buildMicrosandboxCmaGlobEnumerationCommand(
  root: string,
  ownershipToken: string,
): MicrosandboxShellCommand {
  return {
    script: [
      "set -eu",
      "setsid env \"OMA_GLOB_OWNER=$2\" sh -c 'set -eu; printf \"%s\\0\" __OMA_GLOB_READY__; cd \"$1\"; exec find . -type f -print0' \"$2\" \"$1\" &",
      "child=$!",
      "wait \"$child\"",
    ].join("\n"),
    args: [root, ownershipToken],
  };
}

export function buildMicrosandboxGlobEnumerationCommand(
  root: string,
  ignore: readonly string[] = [],
): MicrosandboxShellCommand {
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

export function buildMicrosandboxOutputListingCommand(
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
): MicrosandboxShellCommand {
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

export function buildMicrosandboxBashCommand(
  command: string,
  timeoutSeconds: number,
  pidFile: string,
  dispatchToken = "",
): MicrosandboxShellCommand {
  return {
    script: [
      "pidfile=\"$1\"",
      "timeout_secs=\"$2\"",
      "command=\"$3\"",
      "dispatch_token=\"$4\"",
      "timeout_file=\"${pidfile}.timeout\"",
      "timer_file=\"${pidfile}.timer\"",
      "rm -f \"$pidfile\" \"$timeout_file\" \"$timer_file\"",
      "printf '%s\\n' \"__OMA_DISPATCHED__:${dispatch_token}\"",
      "terminal_exit() { printf '%s\\n' \"__OMA_TERMINAL__:${dispatch_token}:exit:$1\"; }",
      "terminal_timeout() { printf '%s\\n' \"__OMA_TERMINAL__:${dispatch_token}:timeout:137\"; }",
      "setsid /bin/bash -lc \"$command\" &",
      "pid=$!",
      "printf '%s' \"$pid\" > \"$pidfile\"",
      "(",
      "  sleep \"$timeout_secs\"",
      "  if kill -0 \"$pid\" 2>/dev/null; then",
      "    : > \"$timeout_file\"",
      "    kill -KILL \"-$pid\" 2>/dev/null || kill -KILL \"$pid\" 2>/dev/null || true",
      "  fi",
      ") &",
      "timer=$!",
      "printf '%s' \"$timer\" > \"$timer_file\"",
      "wait \"$pid\"",
      "status=$?",
      "if [ -f \"$timeout_file\" ]; then",
      "  kill \"$timer\" 2>/dev/null || true",
      "  wait \"$timer\" 2>/dev/null || true",
      "  rm -f \"$pidfile\" \"$timeout_file\" \"$timer_file\"",
      "  terminal_timeout",
      "  exit 137",
      "fi",
      "kill \"$timer\" 2>/dev/null || true",
      "wait \"$timer\" 2>/dev/null || true",
      "rm -f \"$pidfile\" \"$timeout_file\" \"$timer_file\"",
      "terminal_exit \"$status\"",
      "exit \"$status\"",
    ].join("\n"),
    args: [pidFile, String(timeoutSeconds), command, dispatchToken],
  };
}

export function buildMicrosandboxKillProcessGroupCommand(
  pidFile: string,
): MicrosandboxShellCommand {
  return {
    script: [
      "pidfile=\"$1\"",
      "timerfile=\"${pidfile}.timer\"",
      "timeoutfile=\"${pidfile}.timeout\"",
      "i=0",
      "while [ \"$i\" -lt 50 ]; do",
      "  [ -f \"$pidfile\" ] && break",
      "  sleep 0.01",
      "  i=$((i + 1))",
      "done",
      "if [ -f \"$timerfile\" ]; then",
      "  timer=$(cat \"$timerfile\")",
      "  kill -KILL \"$timer\" 2>/dev/null || true",
      "fi",
      "if [ -f \"$pidfile\" ]; then",
      "  pid=$(cat \"$pidfile\")",
      "  kill -KILL \"-$pid\" 2>/dev/null || kill -KILL \"$pid\" 2>/dev/null || true",
      "  i=0",
      "  while [ \"$i\" -lt 50 ]; do",
      "    kill -0 \"$pid\" 2>/dev/null || break",
      "    sleep 0.02",
      "    i=$((i + 1))",
      "  done",
      "  rm -f \"$pidfile\" \"$timerfile\" \"$timeoutfile\"",
      "fi",
    ].join("\n"),
    args: [pidFile],
  };
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
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let terminalError: Error | undefined;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (result: MicrosandboxCliResult): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onAbort);
      if (terminalError) reject(terminalError);
      else resolve(result);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = (): void => {
      if (settled || terminalError) return;
      terminalError = new Error("aborted");
      terminalError.name = "AbortError";
      child.kill("SIGKILL");
    };
    const collect = (
      target: Buffer[],
      chunk: Buffer,
      onStreamData: ((data: Buffer) => void) | undefined,
    ): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxBuffer) {
        if (!terminalError) {
          terminalError = new Error(
            `Microsandbox command output exceeded ${maxBuffer} bytes`,
          );
          child.kill("SIGKILL");
        }
        return;
      }
      target.push(chunk);
      onStreamData?.(chunk);
      opts.onData?.(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk, opts.onStdout));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk, opts.onStderr));
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
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
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

export function assertInsideMicrosandboxWorkspace(
  absolutePath: string,
  workspacePath = DEFAULT_MICROSANDBOX_WORKSPACE,
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

export function assertInsideMicrosandboxSearchRoot(
  absolutePath: string,
  roots: readonly string[],
): string {
  if (!posix.isAbsolute(absolutePath)) {
    throw new Error(`Sandbox search path must be absolute: ${absolutePath}`);
  }
  const path = posix.resolve(absolutePath);
  for (const rootPath of roots) {
    const root = posix.resolve(rootPath);
    const rel = posix.relative(root, path);
    if (rel === "" || (!rel.startsWith("..") && !posix.isAbsolute(rel))) {
      return path;
    }
  }
  throw new Error(`Sandbox search path escapes approved roots: ${absolutePath}`);
}

export function assertInsideMicrosandboxUploadsPath(
  absolutePath: string,
  uploadsPath = DEFAULT_MICROSANDBOX_UPLOADS_PATH,
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

export function assertInsideMicrosandboxOutputPath(
  absolutePath: string,
  outputsPath = DEFAULT_MICROSANDBOX_OUTPUTS_PATH,
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

export async function reapMicrosandboxSandboxes(
  opts: MicrosandboxSandboxReaperOptions,
): Promise<number> {
  const cli =
    opts.cli ??
    new NodeMicrosandboxCli({
      command: opts.command ?? DEFAULT_MICROSANDBOX_COMMAND,
    });
  const resourceNamePrefix = opts.resourceNamePrefix ?? "oma";
  const listedSandboxes = await microsandboxChecked(
    cli,
    buildMicrosandboxListArgs([
      `${SANDBOX_LABEL_KEY}=${SANDBOX_LABEL_VALUE}`,
      `${OWNER_LABEL_KEY}=${OWNER_LABEL_VALUE}`,
      ...(opts.labelFilters ?? []),
    ]),
  );
  const sandboxNames = parseMicrosandboxListedNames(listedSandboxes.stdout);
  const now = opts.now?.() ?? Date.now();
  const attachedVolumes = new Set<string>();
  const expiredSandboxes: string[] = [];
  for (const name of sandboxNames) {
    try {
      const inspected = await microsandboxChecked(
        cli,
        buildMicrosandboxInspectArgs(name),
      );
      const createdAt = parseMicrosandboxCreatedAt(inspected.stdout);
      if (now - createdAt.getTime() >= opts.olderThanMs) {
        expiredSandboxes.push(name);
      } else {
        collectMicrosandboxVolumeRefs(inspected.stdout, attachedVolumes);
      }
    } catch {
      // One stale/corrupt resource must not wedge all future session creation.
    }
  }
  for (const name of expiredSandboxes) {
    await microsandboxChecked(cli, buildMicrosandboxRemoveArgs(name)).catch(
      () => undefined,
    );
  }
  const listedVolumes = await microsandboxChecked(
    cli,
    buildMicrosandboxVolumeListArgs(),
  );
  const volumeNames = parseMicrosandboxListedNames(listedVolumes.stdout).filter(
    (name) =>
      isOmaMicrosandboxWorkspaceVolumeName(name, resourceNamePrefix) &&
      !attachedVolumes.has(name),
  );
  const expiredVolumes: string[] = [];
  for (const name of volumeNames) {
    try {
      const inspected = await microsandboxChecked(
        cli,
        buildMicrosandboxVolumeInspectArgs(name),
      );
      const createdAt = parseMicrosandboxCreatedAt(inspected.stdout);
      if (now - createdAt.getTime() >= opts.olderThanMs) {
        expiredVolumes.push(name);
      }
    } catch {
      // Skip malformed or concurrently removed volumes.
    }
  }
  for (const name of expiredVolumes) {
    await microsandboxChecked(cli, buildMicrosandboxVolumeRemoveArgs(name)).catch(
      () => undefined,
    );
  }
  return expiredSandboxes.length + expiredVolumes.length;
}

function resolveMicrosandboxOptions(
  opts: MicrosandboxSandboxOptions,
): MicrosandboxResolvedOptions {
  return {
    image: opts.image ?? DEFAULT_MICROSANDBOX_IMAGE,
    cli:
      opts.cli ??
      new NodeMicrosandboxCli({ command: opts.command ?? DEFAULT_MICROSANDBOX_COMMAND }),
    workspacePath: opts.workspacePath ?? DEFAULT_MICROSANDBOX_WORKSPACE,
    uploadsPath: DEFAULT_MICROSANDBOX_UPLOADS_PATH,
    outputsPath: DEFAULT_MICROSANDBOX_OUTPUTS_PATH,
    operationTimeoutMs:
      opts.operationTimeoutMs ?? DEFAULT_MICROSANDBOX_OPERATION_TIMEOUT_MS,
    startupTimeoutMs:
      opts.startupTimeoutMs ?? DEFAULT_MICROSANDBOX_STARTUP_TIMEOUT_MS,
    resourceNamePrefix: opts.resourceNamePrefix ?? "oma",
    cpus: opts.cpus ?? DEFAULT_MICROSANDBOX_CPUS,
    memory: opts.memory ?? DEFAULT_MICROSANDBOX_MEMORY,
    ociUpperSize: opts.ociUpperSize ?? DEFAULT_MICROSANDBOX_OCI_UPPER_SIZE,
    maxDuration: opts.maxDuration ?? DEFAULT_MICROSANDBOX_MAX_DURATION,
    security: opts.security ?? DEFAULT_MICROSANDBOX_SECURITY,
    maxOutputFiles: opts.maxOutputFiles ?? MAX_SESSION_OUTPUT_FILES,
    maxOutputFileBytes:
      opts.maxOutputFileBytes ?? MAX_SESSION_OUTPUT_FILE_BYTES,
    maxOutputBytes: opts.maxOutputBytes ?? MAX_SESSION_OUTPUT_BYTES,
    now: opts.now,
    random: opts.random,
  };
}

async function microsandboxChecked(
  cli: MicrosandboxCli,
  args: readonly string[],
  opts: MicrosandboxCliExecOptions = {},
): Promise<MicrosandboxExecResult> {
  const result = await cli.exec(args, opts);
  if (result.signal !== null || result.status !== 0) {
    throw new Error(
      `msb ${args.join(" ")} failed with ${result.signal ?? result.status}: ${errorText(result)}`,
    );
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  };
}

function forceRemoveMicrosandboxSandbox(
  cli: MicrosandboxCli,
  sandboxName: string,
  resolved: Pick<MicrosandboxResolvedOptions, "operationTimeoutMs">,
): void {
  try {
    cli.execSync(buildMicrosandboxRemoveArgs(sandboxName), {
      timeoutMs: resolved.operationTimeoutMs,
    });
  } catch {
    // Synchronous dispose mirrors Docker-local: cleanup is best-effort at the
    // terminal hook, while create-time partial cleanup preserves the original
    // construction error.
  }
}

async function removeMicrosandboxSandboxChecked(
  cli: MicrosandboxCli,
  sandboxName: string,
  timeoutMs: number,
): Promise<void> {
  const result = await cli.exec(buildMicrosandboxRemoveArgs(sandboxName), {
    timeoutMs,
  });
  if (result.signal === null && result.status === 0) return;
  const detail = errorText(result);
  if (/not found|does not exist|no such/i.test(detail)) return;
  throw new Error(
    `Failed to remove poisoned microsandbox ${sandboxName}: ${detail}`,
  );
}

function forceRemoveMicrosandboxVolume(
  cli: MicrosandboxCli,
  volumeName: string,
  resolved: Pick<MicrosandboxResolvedOptions, "operationTimeoutMs">,
): void {
  try {
    cli.execSync(buildMicrosandboxVolumeRemoveArgs(volumeName), {
      timeoutMs: resolved.operationTimeoutMs,
    });
  } catch {
    // See forceRemoveMicrosandboxSandbox.
  }
}

function killMicrosandboxGuestProcessGroup(
  cli: MicrosandboxCli,
  sandboxName: string,
  pidFile: string,
  resolved: Pick<MicrosandboxResolvedOptions, "operationTimeoutMs">,
): void {
  const command = buildMicrosandboxKillProcessGroupCommand(pidFile);
  try {
    cli.execSync(
      buildMicrosandboxShellExecArgs({
        sandboxName,
        script: command.script,
        args: command.args,
      }),
      { timeoutMs: resolved.operationTimeoutMs },
    );
  } catch {
    // If the control-plane lost the msb exec handle, this follow-up kill is the
    // best remaining way to stop guest work without destroying the session.
    // A failed kill must not mask the original abort/timeout/output error.
  }
}

function errorText(result: MicrosandboxCliResult): string {
  return (
    result.stderr.toString("utf8") ||
    result.stdout.toString("utf8") ||
    "no output"
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isMicrosandboxOutputOverflow(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("Microsandbox command output exceeded ")
  );
}

function timeoutSecondsText(timeoutMs: number): string {
  return `${Math.ceil(timeoutMs / 1000)}s`;
}

function parseOutputListing(
  stdout: Buffer,
): { relativePath: string; sizeBytes: number; sha256: string }[] {
  if (stdout.length === 0) return [];
  const fields = stdout.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 3 !== 0) {
    throw new Error("Microsandbox output listing returned malformed records");
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

function parseMicrosandboxListedNames(stdout: Buffer): string[] {
  const text = stdout.toString("utf8").trim();
  if (text.length === 0) return [];
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Microsandbox list returned non-array JSON");
  }
  return parsed.map((entry) => {
    const name =
      typeof entry === "string"
        ? entry
        : fieldString(entry, ["name", "Name", "id", "ID"]);
    assertMicrosandboxArg(name, "listed sandbox name");
    return name;
  });
}

function parseMicrosandboxCreatedAt(stdout: Buffer): Date {
  const parsed = JSON.parse(stdout.toString("utf8")) as unknown;
  const raw = fieldString(parsed, [
    "created_at",
    "createdAt",
    "Created",
    "created",
  ]);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid microsandbox creation timestamp: ${raw}`);
  }
  return date;
}

function collectMicrosandboxVolumeRefs(
  stdout: Buffer,
  out: Set<string>,
): void {
  visitJsonStrings(JSON.parse(stdout.toString("utf8")) as unknown, (value) => {
    for (const segment of value.split(":")) {
      if (segment.includes("-workspace-volume-")) out.add(segment);
    }
  });
}

function visitJsonStrings(
  value: unknown,
  visit: (value: string) => void,
): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => visitJsonStrings(entry, visit));
    return;
  }
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach((entry) => visitJsonStrings(entry, visit));
  }
}

function isOmaMicrosandboxWorkspaceVolumeName(
  name: string,
  prefix: string,
): boolean {
  return (
    name.startsWith(`${sanitizeMicrosandboxNamePart(prefix)}-`) &&
    name.includes("-workspace-volume-")
  );
}

function fieldString(value: unknown, fields: readonly string[]): string {
  if (typeof value !== "object" || value === null) {
    throw new Error("Microsandbox JSON entry must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const field of fields) {
    const raw = record[field];
    if (typeof raw === "string" && raw.length > 0) return raw;
  }
  throw new Error(`Microsandbox JSON entry missing ${fields.join("/")}`);
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

async function* microsandboxOutputBytes(
  read: () => Promise<{ stdout: Buffer }>,
): AsyncIterable<Uint8Array> {
  yield (await read()).stdout;
}

async function writeMountFile(
  tempRoot: string,
  relativePath: string,
  mount: RuntimeSessionFileMount,
): Promise<string> {
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
  return filePath;
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

function recordSandboxNotDisposed(disposed: SandboxDisposedFlag): void {
  if (disposed.value) throw new Error("Sandbox provider is disposed");
}

function randomExecId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function bashDispatchSentinel(token: string): Buffer {
  return Buffer.from(`${BASH_DISPATCH_PREFIX}${token}\n`);
}

function bashTerminalPrefix(token: string): Buffer {
  return Buffer.from(`${BASH_TERMINAL_PREFIX}${token}:`);
}

export function createMicrosandboxBashDispatchFilter(token: string): {
  chunk: (chunk: Buffer) => Buffer;
  dispatchSeen: () => boolean;
  terminalRecord: () => BashTerminalRecord | undefined;
} {
  const dispatchSentinel = bashDispatchSentinel(token);
  const terminalPrefix = bashTerminalPrefix(token);
  let dispatchSeen = false;
  let terminalRecord: BashTerminalRecord | undefined;
  let pending = Buffer.alloc(0);
  let terminalCandidate = Buffer.alloc(0);

  const filterAfterDispatch = (chunk: Buffer): Buffer => {
    pending = Buffer.concat([pending, chunk]);
    const index = pending.indexOf(terminalPrefix);
    if (index >= 0) {
      const lineEnd = pending.indexOf("\n", index);
      if (lineEnd < 0) {
        const out = pending.subarray(0, index);
        pending = pending.subarray(index);
        return out;
      }
      const line = pending.subarray(index, lineEnd).toString("utf8");
      terminalRecord = parseBashTerminalRecord(line, token);
      const out = Buffer.concat([
        pending.subarray(0, index),
        pending.subarray(lineEnd + 1),
      ]);
      pending = Buffer.alloc(0);
      return out;
    }

    if (terminalCandidate.length > 0) {
      const combined = Buffer.concat([terminalCandidate, pending]);
      if (isPrefixOf(combined, terminalPrefix)) {
        terminalCandidate = combined;
        pending = Buffer.alloc(0);
        return Buffer.alloc(0);
      }
      const out = combined;
      terminalCandidate = Buffer.alloc(0);
      pending = Buffer.alloc(0);
      return out;
    }

    const candidateStart = findTerminalPrefixCandidateStart(
      pending,
      terminalPrefix,
    );
    if (candidateStart < 0) {
      const out = pending;
      pending = Buffer.alloc(0);
      return out;
    }
    const candidate = pending.subarray(candidateStart);
    if (isPrefixOf(candidate, terminalPrefix)) {
      const out = pending.subarray(0, candidateStart);
      terminalCandidate = candidate;
      pending = Buffer.alloc(0);
      return out;
    }
    const out = pending;
    pending = Buffer.alloc(0);
    return out;
  };

  return {
    chunk: (chunk) => {
      if (dispatchSeen) return filterAfterDispatch(chunk);
      pending = Buffer.concat([pending, chunk]);
      const index = pending.indexOf(dispatchSentinel);
      if (index < 0) return Buffer.alloc(0);
      dispatchSeen = true;
      const afterDispatch = Buffer.concat([
        pending.subarray(0, index),
        pending.subarray(index + dispatchSentinel.length),
      ]);
      pending = Buffer.alloc(0);
      return filterAfterDispatch(afterDispatch);
    },
    dispatchSeen: () => dispatchSeen,
    terminalRecord: () => terminalRecord,
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

function assertMicrosandboxArg(value: string, label: string): void {
  if (value.length === 0 || value.startsWith("-")) {
    throw new Error(`Microsandbox ${label} cannot be empty or start with '-'`);
  }
}

function microsandboxLabelArg(key: string, value: string): string {
  if (
    key.length === 0 ||
    key.startsWith("-") ||
    key.includes("=") ||
    value.startsWith("-")
  ) {
    throw new Error("Microsandbox labels cannot be empty, flag-like, or contain '=' in keys");
  }
  return `${key}=${value}`;
}

function microsandboxLabelFilterArg(label: string): string {
  if (label.length === 0 || label.startsWith("-")) {
    throw new Error("Microsandbox label filters cannot be empty or flag-like");
  }
  return label;
}

function sanitizeMicrosandboxNamePart(value: string): string {
  const sanitized = value.toLowerCase().replaceAll(/[^a-z0-9_.-]+/g, "-");
  return sanitized.replaceAll(/^-+|-+$/g, "") || "x";
}
