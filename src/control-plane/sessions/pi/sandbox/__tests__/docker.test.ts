import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  assertInsideDockerWorkspace,
  buildDockerBashCommand,
  buildDockerExecShellArgs,
  buildDockerFileAccessCommand,
  buildDockerGlobEnumerationCommand,
  buildDockerMkdirCommand,
  buildDockerReadFileCommand,
  buildDockerReaddirCommand,
  buildDockerRunArgs,
  buildDockerStatCommand,
  buildDockerWriteFileCommand,
  createBashDispatchFilter,
  createDockerSandboxProvider,
  directoryNamesPrunedByIgnoreGlobs,
  filterDockerEnv,
  reapDockerSandboxContainers,
} from "../docker.ts";

describe("Docker sandbox provider command construction", () => {
  it("constructs the Docker isolation bar explicitly", () => {
    const args = buildDockerRunArgs({
      containerName: "oma-test",
      workspacePath: "/workspace",
      image: "alpine:3.19",
      memory: "128m",
      cpus: "1",
      pidsLimit: "64",
      tmpfsSize: "64m",
      labels: { "open-managed-agents.test": "true" },
    });

    expect(args).toContain("--network");
    expect(args).toContain("none");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop");
    expect(args).toContain("ALL");
    expect(args).toContain("--security-opt");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("--pids-limit");
    expect(args).toContain("64");
    expect(args).toContain("--memory");
    expect(args).toContain("128m");
    expect(args).toContain("--tmpfs");
    expect(args).toContain(
      "/workspace:rw,exec,nosuid,nodev,uid=65534,gid=65534,mode=700,size=64m",
    );
    expect(args).not.toContain("/var/run/docker.sock");
  });

  it("passes shell script arguments separately from the script body", () => {
    expect(
      buildDockerExecShellArgs(
        "container",
        "cat \"$1\"",
        ["/workspace/a file; rm -rf nope"],
        { interactive: true, workdir: "/workspace", env: { SAFE: "yes" } },
      ),
    ).toEqual([
      "exec",
      "-i",
      "--workdir",
      "/workspace",
      "--env",
      "SAFE=yes",
      "container",
      "bash",
      "-lc",
      "cat \"$1\"",
      "bash",
      "/workspace/a file; rm -rf nope",
    ]);
  });

  it("can wrap file-operation shell commands with an in-container timeout", () => {
    expect(
      buildDockerExecShellArgs(
        "container",
        "cat \"$1\"",
        ["/workspace/a.txt"],
        { timeoutSeconds: 2 },
      ),
    ).toEqual([
      "exec",
      "container",
      "bash",
      "-lc",
      "timeout -s KILL \"$1\" bash -lc \"$2\" bash \"${@:3}\"",
      "bash",
      "2",
      "cat \"$1\"",
      "/workspace/a.txt",
    ]);
  });

  it("builds bash commands with in-container timeout and pid tracking", () => {
    expect(
      buildDockerBashCommand("[[ 1 == 1 ]]", 2.5, "/workspace/.oma-exec-test.pid"),
    ).toMatchObject({
      args: ["/workspace/.oma-exec-test.pid", "2.5", "[[ 1 == 1 ]]", ""],
    });
    const command = buildDockerBashCommand("sleep 5", 1, "/workspace/pid");
    expect(command.script).toContain("__OMA_DISPATCHED__");
    expect(command.script).toContain("setsid bash -lc");
    expect(command.script).toContain("sleep \"$timeout_secs\"");
    expect(command.script).toContain("kill -KILL \"-$pid\"");
    expect(command.script).toContain("bash -lc");
  });

  it("filters Docker bash dispatch sentinels before streaming output", () => {
    const filter = createBashDispatchFilter("token");

    expect(filter.stderr(Buffer.from("pending stderr\n"))).toEqual(
      Buffer.alloc(0),
    );
    expect(filter.stdout(Buffer.from("__OMA_DIS"))).toEqual(Buffer.alloc(0));
    expect(filter.stdout(Buffer.from("PATCHED__:token\nhello"))).toEqual(
      Buffer.from("pending stderr\nhello"),
    );
    expect(filter.dispatchSeen()).toBe(true);
    expect(filter.stderr(Buffer.from("later stderr\n"))).toEqual(
      Buffer.from("later stderr\n"),
    );
  });

  it("builds file-operation commands as data", () => {
    expect(buildDockerFileAccessCommand("/workspace/a.txt", "read")).toEqual({
      script: "test -r \"$1\" -a -f \"$1\"",
      args: ["/workspace/a.txt"],
    });
    expect(buildDockerFileAccessCommand("/workspace/a.txt", "edit")).toEqual({
      script: "test -r \"$1\" -a -w \"$1\" -a -f \"$1\"",
      args: ["/workspace/a.txt"],
    });
    expect(buildDockerReadFileCommand("/workspace/a.txt")).toEqual({
      script: "cat \"$1\"",
      args: ["/workspace/a.txt"],
    });
    expect(buildDockerWriteFileCommand("/workspace/a.txt", "hello")).toEqual({
      script: "cat > \"$1\"",
      args: ["/workspace/a.txt"],
      input: "hello",
      interactive: true,
    });
    expect(buildDockerMkdirCommand("/workspace/src")).toEqual({
      script: "mkdir -p \"$1\"",
      args: ["/workspace/src"],
    });
    expect(buildDockerStatCommand("/workspace/src")).toEqual({
      script:
        "if [ -d \"$1\" ]; then printf directory; elif [ -e \"$1\" ]; then printf file; else exit 1; fi",
      args: ["/workspace/src"],
    });
    expect(buildDockerReaddirCommand("/workspace/src")).toEqual({
      script: "ls -1A \"$1\"",
      args: ["/workspace/src"],
    });
    expect(buildDockerGlobEnumerationCommand("/workspace")).toEqual({
      script:
        "cd \"$1\"\nshift\nif [ \"$#\" -eq 0 ]; then\n  find . -type f | sed 's#^./##' | sort\nelse\n  find . \\( -type d \\( \"$@\" \\) -prune \\) -o -type f -print | sed 's#^./##' | sort\nfi",
      args: ["/workspace"],
    });
    expect(
      buildDockerGlobEnumerationCommand("/workspace", [
        "**/node_modules/**",
        "**/.git/**",
      ]),
    ).toMatchObject({
      args: [
        "/workspace",
        "-name",
        ".git",
        "-o",
        "-name",
        "node_modules",
      ],
    });
    expect(
      directoryNamesPrunedByIgnoreGlobs([
        "**/node_modules/**",
        "dist/**",
        "*.ts",
      ]),
    ).toEqual(["dist", "node_modules"]);
  });

  it("keeps Docker paths inside the workspace", () => {
    expect(assertInsideDockerWorkspace("/workspace/src/../a.txt")).toBe(
      "/workspace/a.txt",
    );
    expect(() => assertInsideDockerWorkspace("relative.txt")).toThrow(
      "must be absolute",
    );
    expect(() => assertInsideDockerWorkspace("/etc/passwd")).toThrow(
      "escapes workspace",
    );
  });

  it("filters Docker exec env deny-by-default", () => {
    expect(
      filterDockerEnv(
        { PATH: "/usr/bin", ANTHROPIC_API_KEY: "secret" },
        new Set(["PATH"]),
      ),
    ).toEqual({ PATH: "/usr/bin" });
  });
});

const dockerIt = dockerIsAvailable() ? it : it.skip;

describe("Docker sandbox provider integration", () => {
  dockerIt("runs bash and file operations inside an isolated container", async () => {
    const label = `oma-docker-provider-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const provider = await createDockerSandboxProvider("wrk_test", "sesn_test", {
      envAllowlist: ["SAFE_FLAG"],
      extraLabels: { "open-managed-agents.test-id": label },
      operationTimeoutMs: 15_000,
    });
    try {
      const [containerId] = containersForLabel(label);
      expect(containerId).toBeDefined();
      expect(inspectContainerIsolation(containerId)).toMatchObject({
        networkMode: "none",
        readOnlyRootfs: true,
        capDrop: ["ALL"],
        noNewPrivileges: true,
        user: "65534:65534",
        hasDockerSocketBind: false,
        workspaceTmpfs: true,
        pidsLimit: 64,
        memory: 134217728,
      });

      await provider.operations.write.mkdir("/workspace/src");
      await provider.operations.write.writeFile(
        "/workspace/src/index.ts",
        "export const value = 1;\n",
      );
      await provider.operations.write.writeFile(
        "/workspace/README.md",
        "hello\n",
      );

      await expect(
        provider.operations.find.exists("/workspace/missing.txt"),
      ).resolves.toBe(false);
      await expect(
        provider.operations.ls.exists("/workspace/missing.txt"),
      ).resolves.toBe(false);
      await expect(
        provider.operations.read.readFile("/workspace/src/index.ts"),
      ).resolves.toEqual(Buffer.from("export const value = 1;\n"));
      await provider.operations.edit.access("/workspace/src/index.ts");
      await expect(
        provider.operations.edit.readFile("/workspace/src/index.ts"),
      ).resolves.toEqual(Buffer.from("export const value = 1;\n"));
      await provider.operations.edit.writeFile(
        "/workspace/src/index.ts",
        "export const value = 2;\n",
      );
      await expect(
        provider.operations.read.readFile("/workspace/src/index.ts"),
      ).resolves.toEqual(Buffer.from("export const value = 2;\n"));
      await expect(provider.operations.ls.readdir("/workspace")).resolves.toEqual([
        "README.md",
        "src",
      ]);
      await expect(
        provider.operations.find.glob("*.ts", "/workspace", {
          ignore: [],
          limit: 10,
        }),
      ).resolves.toEqual(["/workspace/src/index.ts"]);

      const chunks: Buffer[] = [];
      const result = await provider.operations.bash.exec(
        "[[ 1 == 1 ]] && printf \"$SAFE_FLAG|$ANTHROPIC_API_KEY\"",
        "/workspace",
        {
          env: { SAFE_FLAG: "yes", ANTHROPIC_API_KEY: "secret" },
          onData: (chunk) => chunks.push(chunk),
          timeout: 1,
        },
      );
      expect(result).toEqual({ exitCode: 0 });
      expect(Buffer.concat(chunks).toString("utf8")).toBe("yes|");
      const failingChunks: Buffer[] = [];
      const failingResult = await provider.operations.bash.exec(
        "ls /nope",
        "/workspace",
        {
          env: {},
          onData: (chunk) => failingChunks.push(chunk),
          timeout: 1,
        },
      );
      expect(failingResult.exitCode).not.toBe(0);
      expect(Buffer.concat(failingChunks).toString("utf8")).toContain("/nope");
      await expect(
        provider.operations.bash.exec("printf fail; exit 7", "/workspace", {
          env: {},
          onData: (chunk) => chunks.push(chunk),
          timeout: 1,
        }),
      ).resolves.toEqual({ exitCode: 7 });
      expect(provider.invocations.byTool.bash).toBe(3);
      expect(provider.invocations.byTool.edit).toBe(3);
      expect(provider.invocations.byTool.find).toBe(2);
      expect(provider.invocations.byTool.ls).toBe(2);
    } finally {
      provider.dispose();
    }
    expect(containersForLabel(label)).toEqual([]);
  }, 60_000);

  dockerIt("cleans up timed-out and aborted Docker exec processes", async () => {
    const label = `oma-docker-timeout-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const provider = await createDockerSandboxProvider("wrk_test", "sesn_test", {
      extraLabels: { "open-managed-agents.test-id": label },
      operationTimeoutMs: 500,
    });
    try {
      await expect(
        provider.operations.bash.exec("sleep 5", "/workspace", {
          env: {},
          onData: () => {},
          timeout: 0.1,
        }),
      ).rejects.toThrow("timeout:0.1");
      await expect(containerHasSleepProcess(label)).resolves.toBe(false);

      await expect(
        provider.operations.bash.exec("sleep 5", "/workspace", {
          env: {},
          onData: () => {},
        }),
      ).rejects.toThrow("timeout:0.5");
      await expect(containerHasSleepProcess(label)).resolves.toBe(false);

      const abort = new AbortController();
      const aborted = provider.operations.bash.exec("sleep 5", "/workspace", {
        env: {},
        onData: () => {},
        signal: abort.signal,
      });
      setTimeout(() => abort.abort(), 100);
      await expect(aborted).rejects.toThrow("aborted");
      await expect(containerHasSleepProcess(label)).resolves.toBe(false);
      expect(containersForLabel(label)).toHaveLength(1);
      await expect(
        provider.operations.bash.exec("printf after-abort", "/workspace", {
          env: {},
          onData: () => {},
          timeout: 1,
        }),
      ).resolves.toEqual({ exitCode: 0 });
    } finally {
      provider.dispose();
    }
    expect(containersForLabel(label)).toEqual([]);
  }, 60_000);

  dockerIt("finds matches beyond a large raw Docker enumeration", async () => {
    const label = `oma-docker-glob-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const provider = await createDockerSandboxProvider("wrk_test", "sesn_test", {
      extraLabels: { "open-managed-agents.test-id": label },
      operationTimeoutMs: 30_000,
    });
    try {
      await provider.operations.bash.exec(
        "mkdir -p big && for i in $(seq -w 1 10020); do : > big/a-$i.txt; done; : > big/zzzz-target.txt",
        "/workspace",
        { env: {}, onData: () => {}, timeout: 20 },
      );
      await expect(
        provider.operations.find.glob("big/zzzz-target.txt", "/workspace", {
          ignore: [],
          limit: 1,
        }),
      ).resolves.toEqual(["/workspace/big/zzzz-target.txt"]);
    } finally {
      provider.dispose();
    }
    expect(containersForLabel(label)).toEqual([]);
  }, 60_000);

  dockerIt("prunes ignored directories during Docker glob enumeration", async () => {
    const label = `oma-docker-glob-prune-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const provider = await createDockerSandboxProvider("wrk_test", "sesn_test", {
      extraLabels: { "open-managed-agents.test-id": label },
      operationTimeoutMs: 15_000,
    });
    try {
      await provider.operations.bash.exec(
        "mkdir -p node_modules && : > a.txt && : > node_modules/hidden.txt && chmod 000 node_modules",
        "/workspace",
        { env: {}, onData: () => {}, timeout: 5 },
      );
      await expect(
        provider.operations.find.glob("*.txt", "/workspace", {
          ignore: ["**/node_modules/**"],
          limit: 10,
        }),
      ).resolves.toEqual(["/workspace/a.txt"]);
    } finally {
      await provider.operations.bash
        .exec("chmod 700 /workspace/node_modules 2>/dev/null || true", "/workspace", {
          env: {},
          onData: () => {},
          timeout: 1,
        })
        .catch(() => undefined);
      provider.dispose();
    }
    expect(containersForLabel(label)).toEqual([]);
  }, 60_000);

  dockerIt("throws when exists cannot reach the Docker container", async () => {
    const label = `oma-docker-exists-fail-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const provider = await createDockerSandboxProvider("wrk_test", "sesn_test", {
      extraLabels: { "open-managed-agents.test-id": label },
      operationTimeoutMs: 15_000,
    });
    try {
      const [containerId] = containersForLabel(label);
      expect(containerId).toBeDefined();
      spawnSync("docker", ["stop", containerId], { stdio: "ignore" });
      await expect(
        provider.operations.find.exists("/workspace/missing.txt"),
      ).rejects.toThrow("docker exists failed");
      await expect(
        provider.operations.ls.exists("/workspace/missing.txt"),
      ).rejects.toThrow("docker exists failed");
      await expect(
        provider.operations.bash.exec("printf should-not-run", "/workspace", {
          env: {},
          onData: () => {},
          timeout: 1,
        }),
      ).rejects.toThrow("docker bash failed before command dispatch");
    } finally {
      provider.dispose();
    }
    expect(containersForLabel(label)).toEqual([]);
  }, 60_000);

  dockerIt("reaps only expired labelled Docker sandbox containers", async () => {
    const label = `oma-docker-reap-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const provider = await createDockerSandboxProvider("wrk_test", "sesn_test", {
      extraLabels: { "open-managed-agents.test-id": label },
      operationTimeoutMs: 15_000,
    });
    try {
      expect(containersForLabel(label)).toHaveLength(1);
      await expect(
        reapDockerSandboxContainers({
          olderThanMs: Number.MAX_SAFE_INTEGER,
          labelFilters: [`open-managed-agents.test-id=${label}`],
        }),
      ).resolves.toBe(0);
      expect(containersForLabel(label)).toHaveLength(1);
      await expect(
        reapDockerSandboxContainers({
          olderThanMs: 0,
          labelFilters: [`open-managed-agents.test-id=${label}`],
        }),
      ).resolves.toBe(1);
      expect(containersForLabel(label)).toEqual([]);
    } finally {
      provider.dispose();
    }
  }, 60_000);
});

function dockerIsAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

function containersForLabel(label: string): string[] {
  const result = spawnSync(
    "docker",
    [
      "ps",
      "-aq",
      "--filter",
      `label=open-managed-agents.test-id=${label}`,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return [];
  return result.stdout.split("\n").filter(Boolean);
}

function inspectContainerIsolation(containerId: string): {
  networkMode: string | undefined;
  readOnlyRootfs: boolean | undefined;
  capDrop: string[] | undefined;
  noNewPrivileges: boolean;
  user: string | undefined;
  hasDockerSocketBind: boolean;
  workspaceTmpfs: boolean;
  pidsLimit: number | undefined;
  memory: number | undefined;
} {
  const result = spawnSync(
    "docker",
    ["inspect", containerId, "--format", "{{json .}}"],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  const inspect = JSON.parse(result.stdout) as {
    Config?: { User?: string };
    HostConfig?: {
      NetworkMode?: string;
      ReadonlyRootfs?: boolean;
      CapDrop?: string[];
      SecurityOpt?: string[];
      Binds?: string[] | null;
      Tmpfs?: Record<string, string>;
      PidsLimit?: number;
      Memory?: number;
    };
  };
  return {
    networkMode: inspect.HostConfig?.NetworkMode,
    readOnlyRootfs: inspect.HostConfig?.ReadonlyRootfs,
    capDrop: inspect.HostConfig?.CapDrop,
    noNewPrivileges:
      inspect.HostConfig?.SecurityOpt?.includes("no-new-privileges") ?? false,
    user: inspect.Config?.User,
    hasDockerSocketBind:
      inspect.HostConfig?.Binds?.some((bind) =>
        bind.includes("/var/run/docker.sock"),
      ) ?? false,
    workspaceTmpfs: Object.keys(inspect.HostConfig?.Tmpfs ?? {}).includes(
      "/workspace",
    ),
    pidsLimit: inspect.HostConfig?.PidsLimit,
    memory: inspect.HostConfig?.Memory,
  };
}

async function containerHasSleepProcess(label: string): Promise<boolean> {
  const [containerId] = containersForLabel(label);
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (containerId === undefined) return false;
  const result = spawnSync(
    "docker",
    ["exec", containerId, "bash", "-lc", "ps | grep '[s]leep' || true"],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  return result.stdout.trim().length > 0;
}
