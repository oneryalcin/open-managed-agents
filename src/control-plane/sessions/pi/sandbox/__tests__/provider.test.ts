import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  assertInsideWorkspace,
  createHostPassthroughSandboxProvider,
  filterEnv,
} from "../provider.ts";

describe("host passthrough sandbox provider (Cycle E.1)", () => {
  it("requires an explicit unsafe opt-in", () => {
    expect(() =>
      createHostPassthroughSandboxProvider({
        workspaceRoot: "/tmp",
        unsafeAllowHostPassthrough: false as true,
      }),
    ).toThrow("explicit unsafe opt-in");
  });

  it("filters bash env deny-by-default with explicit allowlist", () => {
    expect(
      filterEnv(
        {
          PATH: "/usr/bin",
          ANTHROPIC_API_KEY: "secret",
          SAFE_FLAG: "1",
        },
        new Set(["PATH"]),
      ),
    ).toEqual({ PATH: "/usr/bin" });
  });

  it("jails file operations to the workspace root", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-sandbox-"));
    try {
      const provider = createHostPassthroughSandboxProvider({
        workspaceRoot: workspace,
        unsafeAllowHostPassthrough: true,
      });

      await provider.operations.write.writeFile(join(workspace, "ok.txt"), "ok");
      await expect(readFile(join(workspace, "ok.txt"), "utf8")).resolves.toBe(
        "ok",
      );
      expect(() =>
        assertInsideWorkspace(join(workspace, "..", "escape.txt"), workspace),
      ).toThrow("escapes workspace");
      await expect(
        provider.operations.read.readFile(join(workspace, "..", "escape.txt")),
      ).rejects.toThrow("escapes workspace");
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("rejects symlink traversal outside the workspace root", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-sandbox-"));
    const outside = await mkdtemp(join(tmpdir(), "oma-sandbox-outside-"));
    try {
      const provider = createHostPassthroughSandboxProvider({
        workspaceRoot: workspace,
        unsafeAllowHostPassthrough: true,
      });
      await writeFile(join(outside, "secret.txt"), "secret");
      await symlink(outside, join(workspace, "escape"));

      expect(() =>
        assertInsideWorkspace(join(workspace, "escape", "secret.txt"), workspace),
      ).toThrow("escapes workspace");
      await expect(
        provider.operations.read.readFile(join(workspace, "escape", "secret.txt")),
      ).rejects.toThrow("escapes workspace");
      await expect(
        provider.operations.write.writeFile(
          join(workspace, "escape", "new.txt"),
          "nope",
        ),
      ).rejects.toThrow("escapes workspace");
    } finally {
      await rm(workspace, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("executes bash through the provider with filtered env and invocation accounting", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-sandbox-"));
    try {
      const provider = createHostPassthroughSandboxProvider({
        workspaceRoot: workspace,
        unsafeAllowHostPassthrough: true,
        envAllowlist: ["PATH"],
      });
      const chunks: Buffer[] = [];

      const result = await provider.operations.bash.exec(
        "printf \"$PATH|$ANTHROPIC_API_KEY\"",
        workspace,
        {
          env: {
            PATH: "/bin:/usr/bin",
            ANTHROPIC_API_KEY: "secret",
          },
          onData: (chunk) => chunks.push(chunk),
        },
      );

      expect(result).toEqual({ exitCode: 0 });
      expect(Buffer.concat(chunks).toString("utf8")).toBe("/bin:/usr/bin|");
      expect(provider.invocations.total).toBe(1);
      expect(provider.invocations.byTool.bash).toBe(1);
      expect(provider.invocations.byTool.read).toBe(0);
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("records provider-backed Pi tool calls only when operations run", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-sandbox-"));
    try {
      const provider = createHostPassthroughSandboxProvider({
        workspaceRoot: workspace,
        unsafeAllowHostPassthrough: true,
        envAllowlist: ["PATH"],
      });
      const bash = provider.tools.find((tool) => tool.name === "bash");
      expect(bash).toBeDefined();

      await bash?.execute(
        "toolu_provider_bash",
        { command: "printf ok", timeout: 1 },
        new AbortController().signal,
        undefined,
        {} as never,
      );

      expect(provider.invocations.byTool.bash).toBe(1);
      expect(provider.invocations.toolCallIds.bash.has("toolu_provider_bash")).toBe(true);
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("attributes concurrent same-tool provider calls to their own Pi tool ids", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-sandbox-"));
    try {
      const provider = createHostPassthroughSandboxProvider({
        workspaceRoot: workspace,
        unsafeAllowHostPassthrough: true,
        envAllowlist: ["PATH"],
      });
      const bash = provider.tools.find((tool) => tool.name === "bash");
      expect(bash).toBeDefined();

      await Promise.all([
        bash?.execute(
          "toolu_parallel_a",
          { command: "sleep 0.05; printf a", timeout: 1 },
          new AbortController().signal,
          undefined,
          {} as never,
        ),
        bash?.execute(
          "toolu_parallel_b",
          { command: "sleep 0.05; printf b", timeout: 1 },
          new AbortController().signal,
          undefined,
          {} as never,
        ),
      ]);

      expect(provider.invocations.byTool.bash).toBe(2);
      expect(provider.invocations.toolCallIds.bash.has("toolu_parallel_a")).toBe(true);
      expect(provider.invocations.toolCallIds.bash.has("toolu_parallel_b")).toBe(true);
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("treats bash timeout values as seconds", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-sandbox-"));
    try {
      const provider = createHostPassthroughSandboxProvider({
        workspaceRoot: workspace,
        unsafeAllowHostPassthrough: true,
        envAllowlist: ["PATH"],
      });
      const result = await provider.operations.bash.exec("sleep 0.05", workspace, {
        env: { PATH: "/bin:/usr/bin" },
        onData: () => {},
        timeout: 1,
      });

      expect(result).toEqual({ exitCode: 0 });
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("rejects operations after dispose", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-sandbox-"));
    try {
      const provider = createHostPassthroughSandboxProvider({
        workspaceRoot: workspace,
        unsafeAllowHostPassthrough: true,
      });
      provider.dispose();

      await expect(
        provider.operations.read.access(join(workspace, "file.txt")),
      ).rejects.toThrow("disposed");
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("routes find through provider operations inside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-sandbox-"));
    try {
      const provider = createHostPassthroughSandboxProvider({
        workspaceRoot: workspace,
        unsafeAllowHostPassthrough: true,
      });
      await writeFile(join(workspace, "a.txt"), "a");
      await writeFile(join(workspace, "b.md"), "b");
      await provider.operations.write.mkdir(join(workspace, "node_modules"));
      await writeFile(join(workspace, "node_modules", "hidden.txt"), "hidden");

      const results = await provider.operations.find.glob("*.txt", workspace, {
        ignore: ["**/node_modules/**", "**/.git/**"],
        limit: 10,
      });

      const realWorkspace = await realpath(workspace);
      expect(results.map((path) => path.replace(`${realWorkspace}/`, ""))).toEqual([
        "a.txt",
      ]);
      expect(provider.invocations.byTool.find).toBe(1);
      expect(provider.invocations.byTool.write).toBe(1);
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("exposes bounded CMA glob instead of Pi find and accounts public calls", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-sandbox-"));
    try {
      const provider = createHostPassthroughSandboxProvider({
        workspaceRoot: workspace,
        unsafeAllowHostPassthrough: true,
      });
      await writeFile(join(workspace, "a.md"), "a");
      await writeFile(join(workspace, "b.md"), "b");

      expect(provider.toolNames.has("glob")).toBe(true);
      expect(provider.toolNames.has("find")).toBe(false);
      expect(provider.tools.some((tool) => tool.name === "find")).toBe(false);
      const results = await provider.operations.glob.glob({
        pattern: "*.md",
        cwd: workspace,
        signal: new AbortController().signal,
        maxMatches: 100,
        maxRawBytes: 1024 * 1024,
        maxOutputBytes: 64 * 1024,
        timeoutMs: 10_000,
      });

      expect([...results].sort()).toEqual([
        `${await realpath(workspace)}/a.md`,
        `${await realpath(workspace)}/b.md`,
      ]);
      await expect(provider.operations.glob.glob({
        pattern: "*.md",
        cwd: workspace,
        signal: new AbortController().signal,
        maxMatches: 1,
        maxRawBytes: 1024,
        maxOutputBytes: 1024,
        timeoutMs: 10_000,
      })).resolves.toHaveLength(1);
      await expect(provider.operations.glob.glob({
        pattern: "*.md",
        cwd: workspace,
        signal: new AbortController().signal,
        maxMatches: 100,
        maxRawBytes: 1,
        maxOutputBytes: 1024,
        timeoutMs: 10_000,
      })).rejects.toThrow("raw bytes");
      await expect(provider.operations.glob.glob({
        pattern: "*.md",
        cwd: workspace,
        signal: new AbortController().signal,
        maxMatches: 100,
        maxRawBytes: 1024,
        maxOutputBytes: 1024,
        timeoutMs: 0,
      })).rejects.toThrow("timed out");
      const aborted = new AbortController();
      aborted.abort();
      await expect(provider.operations.glob.glob({
        pattern: "*.md",
        cwd: workspace,
        signal: aborted.signal,
        maxMatches: 100,
        maxRawBytes: 1024,
        maxOutputBytes: 1024,
        timeoutMs: 10_000,
      })).rejects.toThrow("Operation aborted");
      const glob = provider.tools.find((tool) => tool.name === "glob");
      expect(glob).toBeDefined();
      const publicResult = await glob!.execute(
        "toolu_glob_test",
        { pattern: "*.md", path: workspace },
        new AbortController().signal,
        undefined,
        {} as never,
      );
      expect(publicResult.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining(`${await realpath(workspace)}/a.md`),
      });
      expect(provider.invocations.byTool.glob).toBe(6);
      expect(provider.invocations.byTool.find).toBe(0);
      expect(provider.invocations.toolCallIds.glob.has("toolu_glob_test")).toBe(true);
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("does not charge host raw-byte limits for directory-only traversal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-sandbox-"));
    try {
      const provider = createHostPassthroughSandboxProvider({
        workspaceRoot: workspace,
        unsafeAllowHostPassthrough: true,
      });
      for (let index = 0; index < 20; index += 1) {
        await mkdir(join(workspace, `directory-${index.toString().padStart(3, "0")}`));
      }
      await expect(provider.operations.glob.glob({
        pattern: "*.md",
        cwd: workspace,
        signal: new AbortController().signal,
        maxMatches: 100,
        maxRawBytes: 1,
        maxOutputBytes: 1024,
        timeoutMs: 10_000,
      })).resolves.toEqual([]);
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("exposes bounded CMA grep and accounts public calls", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-sandbox-"));
    try {
      const provider = createHostPassthroughSandboxProvider({
        workspaceRoot: workspace,
        unsafeAllowHostPassthrough: true,
      });
      await mkdir(join(workspace, "nested"));
      await writeFile(join(workspace, "a.md"), "needle\n");
      await writeFile(join(workspace, "b.txt"), "needle\n");
      await writeFile(join(workspace, "nested", "c.md"), "needle\n");
      await writeFile(join(workspace, "binary.md"), Buffer.from([0x6e, 0x65, 0x00, 0x64]));

      expect(provider.toolNames.has("grep")).toBe(true);
      const results = await provider.operations.grep.grep({
        pattern: "needle",
        cwd: workspace,
        glob: "*.md",
        context: 1,
        headLimit: 100,
        signal: new AbortController().signal,
        maxRawBytes: 1024 * 1024,
        maxOutputBytes: 64 * 1024,
        timeoutMs: 10_000,
      });

      const realWorkspace = await realpath(workspace);
      expect(results.map((path) => path.replace(`${realWorkspace}/`, "")).sort()).toEqual([
        "a.md",
        "nested/c.md",
      ]);
      await expect(provider.operations.grep.grep({
        pattern: "[",
        cwd: workspace,
        context: 0,
        headLimit: 100,
        signal: new AbortController().signal,
        maxRawBytes: 1024 * 1024,
        maxOutputBytes: 64 * 1024,
        timeoutMs: 10_000,
      })).rejects.toThrow();
      const grep = provider.tools.find((tool) => tool.name === "grep");
      expect(grep).toBeDefined();
      const publicResult = await grep!.execute(
        "toolu_grep_test",
        { pattern: "needle", path: workspace, glob: "*.md", context: 1, head_limit: 1 },
        new AbortController().signal,
        undefined,
        {} as never,
      );
      expect(publicResult.content[0]).toMatchObject({
        type: "text",
        text: expect.stringMatching(
          new RegExp(`^${realWorkspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?:a|nested/c)\\.md$`),
        ),
      });
      await expect(grep!.execute(
        "toolu_grep_relative",
        { pattern: "needle", path: "." },
        new AbortController().signal,
        undefined,
        {} as never,
      )).rejects.toThrow("grep path must be absolute");
      expect(provider.invocations.byTool.grep).toBe(3);
      expect(provider.invocations.toolCallIds.grep.has("toolu_grep_test")).toBe(true);
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("prunes ignored directories before traversal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "oma-sandbox-"));
    const ignored = join(workspace, "node_modules");
    try {
      const provider = createHostPassthroughSandboxProvider({
        workspaceRoot: workspace,
        unsafeAllowHostPassthrough: true,
      });
      await writeFile(join(workspace, "a.txt"), "a");
      await mkdir(ignored);
      await writeFile(join(ignored, "hidden.txt"), "hidden");
      await chmod(ignored, 0);

      const results = await provider.operations.find.glob("*.txt", workspace, {
        ignore: ["**/node_modules/**"],
        limit: 10,
      });

      const realWorkspace = await realpath(workspace);
      expect(results.map((path) => path.replace(`${realWorkspace}/`, ""))).toEqual([
        "a.txt",
      ]);
    } finally {
      await chmod(ignored, 0o700).catch(() => undefined);
      await rm(workspace, { force: true, recursive: true });
    }
  });
});
