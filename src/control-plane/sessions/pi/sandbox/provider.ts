import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants, existsSync, realpathSync } from "node:fs";
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { globMatcher, toPosix } from "./glob.ts";
import type { RuntimeSessionFileMount } from "../../../events/types.ts";

export type SandboxedBuiltinToolName =
  | "bash"
  | "read"
  | "write"
  | "edit"
  | "find"
  | "ls";

export interface SandboxInvocationStats {
  readonly total: number;
  readonly byTool: Readonly<Record<SandboxedBuiltinToolName, number>>;
  readonly toolCallIds: Readonly<
    Record<SandboxedBuiltinToolName, ReadonlySet<string>>
  >;
}

export interface SandboxOperations {
  readonly bash: BashOperations;
  readonly read: ReadOperations;
  readonly write: WriteOperations;
  readonly edit: EditOperations;
  readonly find: FindOperations;
  readonly ls: LsOperations;
}

export interface SandboxProvider {
  readonly cwd: string;
  readonly operations: SandboxOperations;
  readonly tools: ToolDefinition<any, any, any>[];
  readonly toolNames: ReadonlySet<SandboxedBuiltinToolName>;
  readonly invocations: SandboxInvocationStats;
  materializeFileResources?(
    mounts: readonly RuntimeSessionFileMount[],
  ): Promise<void> | void;
  collectOutputFiles?(): Promise<readonly SandboxOutputFile[]>;
  dispose(): void;
}

export interface SandboxOutputFile {
  relativePath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
  bytes: AsyncIterable<Uint8Array> | Uint8Array;
}

export type SandboxProviderFactory = (
  workspaceId: string,
  sessionId: string,
) => Promise<SandboxProvider>;

export interface HostPassthroughSandboxOptions {
  workspaceRoot: string;
  unsafeAllowHostPassthrough: true;
  envAllowlist?: string[];
}

export interface MutableSandboxInvocationStats extends SandboxInvocationStats {
  total: number;
  byTool: Record<SandboxedBuiltinToolName, number>;
  toolCallIds: Record<SandboxedBuiltinToolName, Set<string>>;
}

export interface SandboxDisposedFlag {
  value: boolean;
}

interface ToolExecutionContext {
  toolName: SandboxedBuiltinToolName;
  toolCallId: string;
}

const toolExecutionContext = new AsyncLocalStorage<ToolExecutionContext>();

export function createHostPassthroughSandboxProvider(
  opts: HostPassthroughSandboxOptions,
): SandboxProvider {
  if (opts.unsafeAllowHostPassthrough !== true) {
    throw new Error("Host passthrough provider requires explicit unsafe opt-in");
  }
  const workspaceRoot = resolve(opts.workspaceRoot);
  const envAllowlist = new Set(opts.envAllowlist ?? []);
  const invocations = createSandboxInvocationStats();
  const disposed: SandboxDisposedFlag = { value: false };
  const activeProcessGroups = new Set<number>();

  const readOps: ReadOperations = {
    access: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "read");
      await access(assertInsideWorkspace(absolutePath, workspaceRoot));
    },
    readFile: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "read");
      return readFile(assertInsideWorkspace(absolutePath, workspaceRoot));
    },
  };
  const writeOps: WriteOperations = {
    mkdir: async (dir) => {
      recordSandboxInvocation(invocations, disposed, "write");
      await mkdir(assertInsideWorkspace(dir, workspaceRoot), { recursive: true });
    },
    writeFile: async (absolutePath, content) => {
      recordSandboxInvocation(invocations, disposed, "write");
      await writeFileNoFollow(assertInsideWorkspace(absolutePath, workspaceRoot), content);
    },
  };
  const editOps: EditOperations = {
    access: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "edit");
      await access(assertInsideWorkspace(absolutePath, workspaceRoot));
    },
    readFile: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "edit");
      return readFile(assertInsideWorkspace(absolutePath, workspaceRoot));
    },
    writeFile: async (absolutePath, content) => {
      recordSandboxInvocation(invocations, disposed, "edit");
      await writeFileNoFollow(assertInsideWorkspace(absolutePath, workspaceRoot), content);
    },
  };
  const findOps: FindOperations = {
    exists: (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "find");
      return existsSync(assertInsideWorkspace(absolutePath, workspaceRoot));
    },
    glob: async (pattern, cwd, options) => {
      recordSandboxInvocation(invocations, disposed, "find");
      return globInsideWorkspace(pattern, assertInsideWorkspace(cwd, workspaceRoot), {
        ignore: options.ignore,
        limit: options.limit,
        workspaceRoot,
      });
    },
  };
  const lsOps: LsOperations = {
    exists: (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "ls");
      return existsSync(assertInsideWorkspace(absolutePath, workspaceRoot));
    },
    stat: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "ls");
      const result = await stat(assertInsideWorkspace(absolutePath, workspaceRoot));
      return { isDirectory: () => result.isDirectory() };
    },
    readdir: async (absolutePath) => {
      recordSandboxInvocation(invocations, disposed, "ls");
      return readdir(assertInsideWorkspace(absolutePath, workspaceRoot));
    },
  };
  const bashOps: BashOperations = {
    exec: (command, cwd, options) => {
      recordSandboxInvocation(invocations, disposed, "bash");
      return execHostCommand(command, assertInsideWorkspace(cwd, workspaceRoot), {
        activeProcessGroups,
        env: filterEnv(options.env ?? {}, envAllowlist),
        onData: options.onData,
        signal: options.signal,
        timeout: options.timeout,
      });
    },
  };

  return {
    cwd: workspaceRoot,
    invocations,
    operations: {
      bash: bashOps,
      read: readOps,
      write: writeOps,
      edit: editOps,
      find: findOps,
      ls: lsOps,
    },
    toolNames: new Set(["bash", "read", "write", "edit", "find", "ls"]),
    tools: createSandboxToolDefinitions(
      workspaceRoot,
      {
        bash: bashOps,
        read: readOps,
        write: writeOps,
        edit: editOps,
        find: findOps,
        ls: lsOps,
      },
      invocations,
      disposed,
    ),
    dispose: () => {
      disposed.value = true;
      for (const pid of activeProcessGroups) {
        killProcessGroup(pid);
      }
    },
  };
}

export function assertInsideWorkspace(
  absolutePath: string,
  workspaceRoot: string,
): string {
  if (!isAbsolute(absolutePath)) {
    throw new Error(`Sandbox path must be absolute: ${absolutePath}`);
  }
  const resolvedRoot = realpathSync(resolve(workspaceRoot));
  const resolvedPath = resolve(absolutePath);
  const existingAncestor = nearestExistingAncestor(resolvedPath);
  const realAncestor = realpathSync(existingAncestor);
  const realCandidate = resolve(
    realAncestor,
    relative(existingAncestor, resolvedPath),
  );
  if (isInsideOrEqual(realCandidate, resolvedRoot)) {
    // Host passthrough is a guarded test/development provider, not real
    // isolation. This realpath check plus O_NOFOLLOW writes reject existing
    // symlink escapes and final-component write symlinks, but cannot close all
    // intermediate-component TOCTOU races against a concurrent host process.
    // Docker/remote providers must rely on their OS isolation boundary.
    return realCandidate;
  }
  throw new Error(`Sandbox path escapes workspace: ${absolutePath}`);
}

function nearestExistingAncestor(absolutePath: string): string {
  let current = absolutePath;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function isInsideOrEqual(absolutePath: string, root: string): boolean {
  const rel = relative(root, absolutePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function filterEnv(
  source: NodeJS.ProcessEnv,
  allowlist: ReadonlySet<string>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

export function createSandboxInvocationStats(): MutableSandboxInvocationStats {
  return {
    total: 0,
    byTool: emptyToolCounts(),
    toolCallIds: emptyToolCallIds(),
  };
}

export function recordSandboxInvocation(
  invocations: MutableSandboxInvocationStats,
  disposed: SandboxDisposedFlag,
  toolName: SandboxedBuiltinToolName,
): void {
  if (disposed.value) {
    throw new Error("Sandbox provider is disposed");
  }
  invocations.total += 1;
  invocations.byTool[toolName] += 1;
  const context = toolExecutionContext.getStore();
  if (context?.toolName === toolName) {
    invocations.toolCallIds[toolName].add(context.toolCallId);
  }
}

export function createSandboxToolDefinitions(
  cwd: string,
  operations: SandboxOperations,
  invocations: MutableSandboxInvocationStats,
  disposed: SandboxDisposedFlag,
): ToolDefinition<any, any, any>[] {
  return [
    withToolCallAccounting(
      "bash",
      createBashToolDefinition(cwd, { operations: operations.bash }),
      invocations,
      disposed,
    ),
    withToolCallAccounting(
      "read",
      createReadToolDefinition(cwd, { operations: operations.read }),
      invocations,
      disposed,
    ),
    withToolCallAccounting(
      "write",
      createWriteToolDefinition(cwd, { operations: operations.write }),
      invocations,
      disposed,
    ),
    withToolCallAccounting(
      "edit",
      createEditToolDefinition(cwd, { operations: operations.edit }),
      invocations,
      disposed,
    ),
    withToolCallAccounting(
      "find",
      createFindToolDefinition(cwd, { operations: operations.find }),
      invocations,
      disposed,
    ),
    withToolCallAccounting(
      "ls",
      createLsToolDefinition(cwd, { operations: operations.ls }),
      invocations,
      disposed,
    ),
  ];
}

function emptyToolCounts(): Record<SandboxedBuiltinToolName, number> {
  return {
    bash: 0,
    read: 0,
    write: 0,
    edit: 0,
    find: 0,
    ls: 0,
  };
}

function emptyToolCallIds(): Record<SandboxedBuiltinToolName, Set<string>> {
  return {
    bash: new Set(),
    read: new Set(),
    write: new Set(),
    edit: new Set(),
    find: new Set(),
    ls: new Set(),
  };
}

function withToolCallAccounting<T extends ToolDefinition<any, any, any>>(
  toolName: SandboxedBuiltinToolName,
  tool: T,
  invocations: MutableSandboxInvocationStats,
  disposed: SandboxDisposedFlag,
): T {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      if (disposed.value) {
        throw new Error("Sandbox provider is disposed");
      }
      return toolExecutionContext.run({ toolName, toolCallId }, () =>
        tool.execute(toolCallId, params, signal, onUpdate, ctx),
      );
    },
  };
}

async function writeFileNoFollow(path: string, content: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o666,
  );
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

async function execHostCommand(
  command: string,
  cwd: string,
  opts: {
    env: NodeJS.ProcessEnv;
    activeProcessGroups: Set<number>;
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
  },
): Promise<{ exitCode: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd,
      env: opts.env,
      detached: true,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid !== undefined) {
      opts.activeProcessGroups.add(child.pid);
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (child.pid !== undefined) opts.activeProcessGroups.delete(child.pid);
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
      settle(() => reject(new Error("Operation aborted")));
    };

    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.timeout !== undefined && opts.timeout > 0) {
      timer = setTimeout(() => {
        kill();
        settle(() => resolvePromise({ exitCode: null }));
      }, opts.timeout * 1000);
    }
    child.stdout?.on("data", (chunk: Buffer) => opts.onData(chunk));
    child.stderr?.on("data", (chunk: Buffer) => opts.onData(chunk));
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code) =>
      settle(() => resolvePromise({ exitCode: code })),
    );
  });
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid);
  } catch {
    // The process may already have exited. Callers may also kill the direct
    // child as a fallback when they own the ChildProcess object.
  }
}

async function globInsideWorkspace(
  pattern: string,
  cwd: string,
  opts: {
    ignore: string[];
    limit: number;
    workspaceRoot: string;
  },
): Promise<string[]> {
  const matcher = globMatcher(pattern);
  const ignores = opts.ignore.map(globMatcher);
  const out: string[] = [];
  const isIgnored = (rel: string) =>
    ignores.some((ignore) => ignore(rel) || ignore(`${rel}/`));

  async function visit(dir: string): Promise<void> {
    if (out.length >= opts.limit) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= opts.limit) return;
      const fullPath = assertInsideWorkspace(
        `${dir}${sep}${entry.name}`,
        opts.workspaceRoot,
      );
      const rel = toPosix(relative(cwd, fullPath));
      if (isIgnored(rel)) continue;
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (matcher(rel)) {
        out.push(fullPath);
      }
    }
  }

  await visit(cwd);
  return out;
}
