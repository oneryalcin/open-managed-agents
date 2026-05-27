import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
});
