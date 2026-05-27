import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
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
  createBashTool,
  createEditTool,
  createFindTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";

export type SandboxedBuiltinToolName =
  | "bash"
  | "read"
  | "write"
  | "edit"
  | "find"
  | "ls";

type PiAgentTool =
  | ReturnType<typeof createBashTool>
  | ReturnType<typeof createReadTool>
  | ReturnType<typeof createWriteTool>
  | ReturnType<typeof createEditTool>
  | ReturnType<typeof createFindTool>
  | ReturnType<typeof createLsTool>;

export interface SandboxInvocationStats {
  readonly total: number;
  readonly byTool: Readonly<Record<SandboxedBuiltinToolName, number>>;
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
  readonly tools: PiAgentTool[];
  readonly toolNames: ReadonlySet<SandboxedBuiltinToolName>;
  readonly invocations: SandboxInvocationStats;
  dispose(): void;
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

interface MutableSandboxInvocationStats extends SandboxInvocationStats {
  total: number;
  byTool: Record<SandboxedBuiltinToolName, number>;
}

export function createHostPassthroughSandboxProvider(
  opts: HostPassthroughSandboxOptions,
): SandboxProvider {
  if (opts.unsafeAllowHostPassthrough !== true) {
    throw new Error("Host passthrough provider requires explicit unsafe opt-in");
  }
  const workspaceRoot = resolve(opts.workspaceRoot);
  const envAllowlist = new Set(opts.envAllowlist ?? []);
  const invocations: MutableSandboxInvocationStats = {
    total: 0,
    byTool: emptyToolCounts(),
  };
  const disposed = { value: false };

  const readOps: ReadOperations = {
    access: async (absolutePath) => {
      record(invocations, disposed, "read");
      await access(assertInsideWorkspace(absolutePath, workspaceRoot));
    },
    readFile: async (absolutePath) => {
      record(invocations, disposed, "read");
      return readFile(assertInsideWorkspace(absolutePath, workspaceRoot));
    },
  };
  const writeOps: WriteOperations = {
    mkdir: async (dir) => {
      record(invocations, disposed, "write");
      await mkdir(assertInsideWorkspace(dir, workspaceRoot), { recursive: true });
    },
    writeFile: async (absolutePath, content) => {
      record(invocations, disposed, "write");
      await writeFile(assertInsideWorkspace(absolutePath, workspaceRoot), content, "utf8");
    },
  };
  const editOps: EditOperations = {
    access: async (absolutePath) => {
      record(invocations, disposed, "edit");
      await access(assertInsideWorkspace(absolutePath, workspaceRoot));
    },
    readFile: async (absolutePath) => {
      record(invocations, disposed, "edit");
      return readFile(assertInsideWorkspace(absolutePath, workspaceRoot));
    },
    writeFile: async (absolutePath, content) => {
      record(invocations, disposed, "edit");
      await writeFile(assertInsideWorkspace(absolutePath, workspaceRoot), content, "utf8");
    },
  };
  const findOps: FindOperations = {
    exists: (absolutePath) => {
      record(invocations, disposed, "find");
      return existsSync(assertInsideWorkspace(absolutePath, workspaceRoot));
    },
    glob: async (pattern, cwd, options) => {
      record(invocations, disposed, "find");
      return globInsideWorkspace(pattern, assertInsideWorkspace(cwd, workspaceRoot), {
        ignore: options.ignore,
        limit: options.limit,
        workspaceRoot,
      });
    },
  };
  const lsOps: LsOperations = {
    exists: (absolutePath) => {
      record(invocations, disposed, "ls");
      return existsSync(assertInsideWorkspace(absolutePath, workspaceRoot));
    },
    stat: async (absolutePath) => {
      record(invocations, disposed, "ls");
      const result = await stat(assertInsideWorkspace(absolutePath, workspaceRoot));
      return { isDirectory: () => result.isDirectory() };
    },
    readdir: async (absolutePath) => {
      record(invocations, disposed, "ls");
      return readdir(assertInsideWorkspace(absolutePath, workspaceRoot));
    },
  };
  const bashOps: BashOperations = {
    exec: (command, cwd, options) => {
      record(invocations, disposed, "bash");
      return execHostCommand(command, assertInsideWorkspace(cwd, workspaceRoot), {
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
    tools: [
      createBashTool(workspaceRoot, { operations: bashOps }),
      createReadTool(workspaceRoot, { operations: readOps }),
      createWriteTool(workspaceRoot, { operations: writeOps }),
      createEditTool(workspaceRoot, { operations: editOps }),
      createFindTool(workspaceRoot, { operations: findOps }),
      createLsTool(workspaceRoot, { operations: lsOps }),
    ],
    dispose: () => {
      disposed.value = true;
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
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedPath = resolve(absolutePath);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return resolvedPath;
  }
  throw new Error(`Sandbox path escapes workspace: ${absolutePath}`);
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

function record(
  invocations: MutableSandboxInvocationStats,
  disposed: { value: boolean },
  toolName: SandboxedBuiltinToolName,
): void {
  if (disposed.value) {
    throw new Error("Sandbox provider is disposed");
  }
  invocations.total += 1;
  invocations.byTool[toolName] += 1;
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

async function execHostCommand(
  command: string,
  cwd: string,
  opts: {
    env: NodeJS.ProcessEnv;
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
  },
): Promise<{ exitCode: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd,
      env: opts.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const kill = () => {
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
      }, opts.timeout);
    }
    child.stdout?.on("data", (chunk: Buffer) => opts.onData(chunk));
    child.stderr?.on("data", (chunk: Buffer) => opts.onData(chunk));
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code) =>
      settle(() => resolvePromise({ exitCode: code })),
    );
  });
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
      if (ignores.some((ignore) => ignore(rel))) continue;
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

function globMatcher(pattern: string): (value: string) => boolean {
  const normalized = toPosix(pattern);
  const regex = globToRegexSource(normalized);
  const exact = new RegExp(`^${regex}$`);
  const basename = new RegExp(`(^|/)${regex}$`);
  return (value) => exact.test(toPosix(value)) || basename.test(toPosix(value));
}

function globToRegexSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    const afterNext = pattern[i + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      out += "(?:.*/)?";
      i += 2;
    } else if (char === "*" && next === "*") {
      out += ".*";
      i += 1;
    } else if (char === "*") {
      out += "[^/]*";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

function toPosix(value: string): string {
  return value.split(sep).join("/");
}
