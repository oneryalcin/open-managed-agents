import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants, existsSync, realpathSync } from "node:fs";
import {
  access,
  mkdir,
  open,
  opendir,
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
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { compileCmaGlob } from "./cma-glob.ts";
import {
  CMA_GREP_MAX_OUTPUT_BYTES,
  CMA_GREP_MAX_RAW_BYTES,
  CMA_GREP_TIMEOUT_MS,
  CmaGrepInputError,
  assertCmaGrepContext,
  assertCmaGrepHeadLimit,
  assertCmaGrepPath,
  assertCmaGrepPattern,
  formatCmaGrepOutput,
  outputRelativeTo,
} from "./cma-grep.ts";
import { globMatcher, toPosix } from "./glob.ts";
import type { RuntimeSessionFileMount } from "../../../events/types.ts";

export type SandboxedBuiltinToolName =
  | "bash"
  | "read"
  | "write"
  | "edit"
  | "find"
  | "glob"
  | "grep"
  | "ls";

export interface SandboxInvocationStats {
  readonly total: number;
  readonly byTool: Readonly<Record<SandboxedBuiltinToolName, number>>;
  readonly toolCallIds: Readonly<
    Record<SandboxedBuiltinToolName, ReadonlySet<string>>
  >;
}

export interface CmaGlobOperations {
  glob(input: {
    pattern: string;
    cwd: string;
    signal: AbortSignal;
    maxMatches: number;
    maxRawBytes: number;
    maxOutputBytes: number;
    outputBase?: string;
    timeoutMs: number;
  }): Promise<string[]>;
}

export interface CmaGrepOperations {
  grep(input: {
    pattern: string;
    cwd: string;
    signal: AbortSignal;
    glob?: string;
    context: number;
    headLimit: number;
    maxRawBytes: number;
    maxOutputBytes: number;
    outputBase?: string;
    timeoutMs: number;
  }): Promise<string[]>;
}

export interface SandboxOperations {
  readonly bash: BashOperations;
  readonly read: ReadOperations;
  readonly write: WriteOperations;
  readonly edit: EditOperations;
  readonly find: FindOperations;
  readonly glob: CmaGlobOperations;
  readonly grep: CmaGrepOperations;
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
  /**
   * A poisoned provider has destroyed its isolation boundary after an
   * ambiguous operation dispatch and must not remain attached to a warm
   * runtime handle.
   */
  isPoisoned?(): boolean;
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

export interface SandboxProviderSessionContext {
  /**
   * Creation-time hint for sessions whose sandbox is prepared before the row is
   * committed. Providers that need environment-scoped resources can use this
   * instead of looking the session row up by id.
   */
  environmentId?: string;
}

export type SandboxProviderFactory = (
  workspaceId: string,
  sessionId: string,
  context?: SandboxProviderSessionContext,
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
  const globOps: CmaGlobOperations = {
    glob: async ({ pattern, cwd, signal, maxMatches, maxRawBytes, maxOutputBytes, outputBase, timeoutMs }) => {
      recordSandboxInvocation(invocations, disposed, "glob");
      return cmaGlobInsideWorkspace({
        pattern,
        cwd: assertInsideWorkspace(cwd, workspaceRoot),
        workspaceRoot,
        signal,
        maxMatches,
        maxRawBytes,
        maxOutputBytes,
        outputBase,
        timeoutMs,
      });
    },
  };
  const grepOps: CmaGrepOperations = {
    grep: async ({ pattern, cwd, signal, glob, headLimit, maxRawBytes, maxOutputBytes, outputBase, timeoutMs }) => {
      recordSandboxInvocation(invocations, disposed, "grep");
      return cmaGrepInsideWorkspace({
        pattern,
        cwd: assertInsideWorkspace(cwd, workspaceRoot),
        workspaceRoot,
        signal,
        glob,
        headLimit,
        maxRawBytes,
        maxOutputBytes,
        outputBase,
        timeoutMs,
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
      glob: globOps,
      grep: grepOps,
      ls: lsOps,
    },
    toolNames: new Set(["bash", "read", "write", "edit", "glob", "grep", "ls"]),
    tools: createSandboxToolDefinitions(
      workspaceRoot,
      {
        bash: bashOps,
        read: readOps,
        write: writeOps,
        edit: editOps,
        find: findOps,
        glob: globOps,
        grep: grepOps,
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

const CMA_GLOB_MAX_MATCHES = 100;
const CMA_GLOB_MAX_RAW_BYTES = 1024 * 1024;
const CMA_GLOB_MAX_OUTPUT_BYTES = 64 * 1024;
const CMA_GLOB_TIMEOUT_MS = 10_000;

function createCmaGlobToolDefinition(
  cwd: string,
  operations: CmaGlobOperations,
): ToolDefinition<any, any, any> {
  return defineTool({
    name: "glob",
    label: "glob",
    description: "Find files recursively using a glob pattern.",
    parameters: Type.Object(
      {
        pattern: Type.String({ description: "Glob pattern to match" }),
        path: Type.Optional(Type.String({ description: "Directory to search" })),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, input: { pattern: string; path?: string }, signal) => {
      // Compile before provider execution so malformed/over-complex patterns do
      // not start a sandbox command.
      compileCmaGlob(input.pattern);
      const suppliedPath = input.path;
      const searchRoot = resolve(cwd, suppliedPath ?? ".");
      const effectiveSignal = signal ?? new AbortController().signal;
      const matches = await operations.glob({
        pattern: input.pattern,
        cwd: searchRoot,
        signal: effectiveSignal,
        maxMatches: CMA_GLOB_MAX_MATCHES,
        maxRawBytes: CMA_GLOB_MAX_RAW_BYTES,
        maxOutputBytes: CMA_GLOB_MAX_OUTPUT_BYTES,
        outputBase: suppliedPath === undefined || !isAbsolute(suppliedPath) ? cwd : undefined,
        timeoutMs: CMA_GLOB_TIMEOUT_MS,
      });
      const formatted = matches.map((match) => {
        if (suppliedPath === undefined) return toPosix(relative(cwd, match));
        if (isAbsolute(suppliedPath)) return toPosix(match);
        return toPosix(relative(cwd, match));
      });
      return {
        content: [{ type: "text", text: formatted.length === 0 ? "No files found" : formatted.join("\n") }],
        details: undefined,
      };
    },
  });
}

function createCmaGrepToolDefinition(
  _cwd: string,
  operations: CmaGrepOperations,
): ToolDefinition<any, any, any> {
  return defineTool({
    name: "grep",
    label: "grep",
    description: "Search file contents and return matching file paths.",
    parameters: Type.Object(
      {
        pattern: Type.String({ description: "POSIX extended regular expression to search for" }),
        path: Type.String({ description: "Absolute directory or file path to search" }),
        glob: Type.Optional(Type.String({ description: "Optional glob filter for files to search" })),
        context: Type.Optional(Type.Number({ description: "Accepted for CMA compatibility; output remains matching paths" })),
        head_limit: Type.Optional(Type.Number({ description: "Maximum matching paths to return" })),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, input: {
      pattern: unknown;
      path: unknown;
      glob?: unknown;
      context?: unknown;
      head_limit?: unknown;
    }, signal) => {
      const pattern = assertCmaGrepPattern(input.pattern);
      const path = assertCmaGrepPath(input.path);
      const context = assertCmaGrepContext(input.context);
      const headLimit = assertCmaGrepHeadLimit(input.head_limit);
      let glob: string | undefined;
      if (input.glob !== undefined) {
        if (typeof input.glob !== "string" || input.glob.length === 0) {
          throw new CmaGrepInputError("grep glob must be a non-empty string");
        }
        compileCmaGlob(input.glob);
        glob = input.glob;
      }
      const effectiveSignal = signal ?? new AbortController().signal;
      const matches = await operations.grep({
        pattern,
        cwd: path,
        signal: effectiveSignal,
        glob,
        context,
        headLimit,
        maxRawBytes: CMA_GREP_MAX_RAW_BYTES,
        maxOutputBytes: CMA_GREP_MAX_OUTPUT_BYTES,
        timeoutMs: CMA_GREP_TIMEOUT_MS,
      });
      return {
        content: [{ type: "text", text: formatCmaGrepOutput(matches) }],
        details: undefined,
      };
    },
  });
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
      "glob",
      createCmaGlobToolDefinition(cwd, operations.glob),
      invocations,
      disposed,
    ),
    withToolCallAccounting(
      "grep",
      createCmaGrepToolDefinition(cwd, operations.grep),
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
    glob: 0,
    grep: 0,
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
    glob: new Set(),
    grep: new Set(),
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

async function cmaGlobInsideWorkspace(opts: {
  pattern: string;
  cwd: string;
  workspaceRoot: string;
  signal: AbortSignal;
  maxMatches: number;
  maxRawBytes: number;
  maxOutputBytes: number;
  outputBase?: string;
  timeoutMs: number;
}): Promise<string[]> {
  const matcher = compileCmaGlob(opts.pattern);
  const deadline = Date.now() + opts.timeoutMs;
  const matches: string[] = [];
  let rawBytes = 0;
  let outputBytes = 0;
  const assertActive = (): void => {
    if (opts.signal.aborted) throw new Error("Operation aborted");
    if (Date.now() >= deadline) throw new Error("Glob operation timed out");
  };
  async function visit(dir: string): Promise<void> {
    assertActive();
    const handle = await opendir(dir);
    for await (const entry of handle) {
      assertActive();
      if (matches.length >= opts.maxMatches) return;
      const fullPath = assertInsideWorkspace(`${dir}${sep}${entry.name}`, opts.workspaceRoot);
      const relativePath = toPosix(relative(opts.cwd, fullPath));
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else {
        // Docker/microsandbox enumerate `find -type f`; host raw accounting
        // therefore counts only equivalent emitted file records.
        rawBytes += Buffer.byteLength(relativePath, "utf8") + 1;
        if (rawBytes > opts.maxRawBytes) {
          throw new Error(`Glob enumeration exceeds ${opts.maxRawBytes} raw bytes`);
        }
        if (!matcher.matches(relativePath)) continue;
        const outputPath = opts.outputBase === undefined
          ? fullPath
          : toPosix(relative(opts.outputBase, fullPath));
        const addedBytes = Buffer.byteLength(outputPath, "utf8") +
          (matches.length === 0 ? 0 : 1);
        if (outputBytes + addedBytes > opts.maxOutputBytes) {
          throw new Error(`Glob output exceeds ${opts.maxOutputBytes} bytes`);
        }
        outputBytes += addedBytes;
        matches.push(fullPath);
      }
    }
  }
  await visit(opts.cwd);
  return matches;
}

async function cmaGrepInsideWorkspace(opts: {
  pattern: string;
  cwd: string;
  workspaceRoot: string;
  signal: AbortSignal;
  glob?: string;
  headLimit: number;
  maxRawBytes: number;
  maxOutputBytes: number;
  outputBase?: string;
  timeoutMs: number;
}): Promise<string[]> {
  let regex: RegExp;
  try {
    regex = new RegExp(opts.pattern);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Invalid regex pattern");
  }
  const matcher = opts.glob === undefined ? undefined : compileCmaGlob(opts.glob);
  const deadline = Date.now() + opts.timeoutMs;
  const matches: string[] = [];
  let rawBytes = 0;
  let outputBytes = 0;
  const assertActive = (): void => {
    if (opts.signal.aborted) throw new Error("Operation aborted");
    if (Date.now() >= deadline) throw new Error("Grep operation timed out");
  };
  async function visit(path: string): Promise<void> {
    assertActive();
    const stats = await stat(path);
    if (stats.isDirectory()) {
      const handle = await opendir(path);
      for await (const entry of handle) {
        assertActive();
        if (matches.length >= opts.headLimit) return;
        await visit(assertInsideWorkspace(`${path}${sep}${entry.name}`, opts.workspaceRoot));
      }
      return;
    }
    if (!stats.isFile()) return;
    const relativePath = toPosix(relative(opts.cwd, path));
    rawBytes += Buffer.byteLength(relativePath, "utf8") + 1;
    if (rawBytes > opts.maxRawBytes) {
      throw new Error(`Grep enumeration exceeds ${opts.maxRawBytes} raw bytes`);
    }
    if (matcher !== undefined && !matcher.matches(relativePath)) return;
    const bytes = await readFile(path);
    if (bytes.includes(0)) return;
    if (!regex.test(bytes.toString("utf8"))) return;
    const outputPath = opts.outputBase === undefined ? path : outputRelativeTo(opts.outputBase, path);
    const addedBytes = Buffer.byteLength(outputPath, "utf8") +
      (matches.length === 0 ? 0 : 1);
    if (outputBytes + addedBytes > opts.maxOutputBytes) {
      throw new Error(`Grep output exceeds ${opts.maxOutputBytes} bytes`);
    }
    outputBytes += addedBytes;
    matches.push(path);
  }
  await visit(opts.cwd);
  return matches;
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
