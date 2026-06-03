import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertInsideUploadsPath,
  assertInsideDockerWorkspace,
  buildDockerBashCommand,
  buildDockerExtractIntoContainerArgs,
  buildDockerExecShellArgs,
  buildDockerFileAccessCommand,
  buildDockerGlobEnumerationCommand,
  buildDockerMkdirCommand,
  buildDockerNormalizeUploadsArgs,
  buildDockerOutputListingCommand,
  buildDockerReadFileCommand,
  buildDockerReaddirCommand,
  buildDockerRunArgs,
  buildDockerStatCommand,
  buildDockerWriteFileCommand,
  createBashDispatchFilter,
  createDockerSandboxProviderFactory,
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
      memory: "256m",
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
    expect(args).toContain("256m");
    expect(args).toContain("--tmpfs");
    expect(args).toContain(
      "/workspace:rw,exec,nosuid,nodev,uid=65534,gid=65534,mode=700,size=64m",
    );
    expect(args).toContain(
      "/mnt/session/uploads:rw,nosuid,nodev,noexec,mode=755,size=64m",
    );
    expect(args).toContain(
      "/mnt/session/outputs:rw,nosuid,nodev,noexec,uid=65534,gid=65534,mode=700,size=100m",
    );
    expect(args).not.toContain("/var/run/docker.sock");
  });

  it("rejects Docker tmpfs sizing that leaves no process memory headroom", () => {
    expect(() =>
      buildDockerRunArgs({
        containerName: "oma-test",
        workspacePath: "/workspace",
        image: "alpine:3.19",
        memory: "192m",
        cpus: "1",
        pidsLimit: "64",
        tmpfsSize: "64m",
      }),
    ).toThrow(
      "memory must exceed workspace tmpfs plus uploads tmpfs plus outputs tmpfs",
    );
    expect(() =>
      buildDockerRunArgs({
        containerName: "oma-test",
        workspacePath: "/workspace",
        image: "alpine:3.19",
        memory: "256MiB",
        cpus: "1",
        pidsLimit: "64",
        tmpfsSize: "64m",
      }),
    ).toThrow("must use bytes or a k/m/g suffix");
  });

  it("allows a separately sized outputs tmpfs", () => {
    const args = buildDockerRunArgs({
      containerName: "oma-test",
      workspacePath: "/workspace",
      image: "alpine:3.19",
      memory: "256m",
      cpus: "1",
      pidsLimit: "64",
      tmpfsSize: "64m",
      outputsTmpfsSize: "16m",
    });

    expect(args).toContain(
      "/mnt/session/outputs:rw,nosuid,nodev,noexec,uid=65534,gid=65534,mode=700,size=16m",
    );
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

  it("builds root-owned upload materialization commands explicitly", () => {
    expect(
      buildDockerExtractIntoContainerArgs(
        "container",
        "/mnt/session/uploads",
      ),
    ).toEqual([
      "exec",
      "-i",
      "--user",
      "0:0",
      "container",
      "tar",
      "--no-same-owner",
      "-C",
      "/mnt/session/uploads",
      "-xf",
      "-",
    ]);
    expect(
      buildDockerNormalizeUploadsArgs("container", "/mnt/session/uploads"),
    ).toEqual([
      "exec",
      "--user",
      "0:0",
      "container",
      "sh",
      "-c",
      "chown -R 0:0 \"$1\" && find \"$1\" -type d -exec chmod 755 {} + && find \"$1\" -type f -exec chmod 644 {} +",
      "sh",
      "/mnt/session/uploads",
    ]);
  });

  it("builds output listing commands under the mounted outputs root", () => {
    const command = buildDockerOutputListingCommand("/mnt/session/outputs", {
      maxFiles: 7,
      maxFileBytes: 1024,
      maxBytes: 4096,
    });

    expect(command.args).toEqual(["/mnt/session/outputs", "7", "1024", "4096"]);
    expect(command.script).toContain("find . -type f -print0");
    expect(command.script).toContain("count=$((count + 1))");
    expect(command.script).toContain("size=$(wc -c < \"$file\")");
    expect(command.script).toContain("session output file count exceeds");
    expect(command.script).toContain("session output bytes exceed");
    expect(command.script).toContain("sha256sum");
  });

  it("builds bash commands with in-container timeout and pid tracking", () => {
    expect(
      buildDockerBashCommand("[[ 1 == 1 ]]", 2.5, "/workspace/.oma-exec-test.pid"),
    ).toMatchObject({
      args: ["/workspace/.oma-exec-test.pid", "2.5", "[[ 1 == 1 ]]", ""],
    });
    const command = buildDockerBashCommand("sleep 5", 1, "/workspace/pid");
    expect(command.script).toContain("__OMA_DISPATCHED__");
    expect(command.script).toContain("__OMA_TERMINAL__");
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
    expect(
      filter.stdout(Buffer.from("__OMA_TERMINAL__:token:exit:7\n")),
    ).toEqual(Buffer.alloc(0));
    expect(filter.terminalRecord()).toEqual({ kind: "exit", exitCode: 7 });
    expect(filter.dispatchSeen()).toBe(true);
    expect(filter.stderr(Buffer.from("later stderr\n"))).toEqual(
      Buffer.from("later stderr\n"),
    );
  });

  it("keeps Docker bash timeout terminal markers out of streamed output", () => {
    const filter = createBashDispatchFilter("token");

    expect(
      filter.stdout(
        Buffer.from(
          "__OMA_DISPATCHED__:token\npartial__OMA_TERMINAL__:token:time",
        ),
      ),
    ).toEqual(Buffer.from("partial"));
    expect(filter.stdout(Buffer.from("out:137\n"))).toEqual(Buffer.alloc(0));
    expect(filter.dispatchSeen()).toBe(true);
    expect(filter.terminalRecord()).toEqual({ kind: "timeout", exitCode: 137 });
  });

  it("streams post-dispatch output unless it could be a terminal marker", () => {
    const filter = createBashDispatchFilter("token");

    expect(filter.stdout(Buffer.from("__OMA_DISPATCHED__:token\nready"))).toEqual(
      Buffer.from("ready"),
    );
    expect(filter.stdout(Buffer.from("__"))).toEqual(Buffer.alloc(0));
    expect(filter.stdout(Buffer.from("not-marker"))).toEqual(
      Buffer.from("__not-marker"),
    );
    expect(filter.terminalRecord()).toBeUndefined();
  });

  it("fails closed for malformed or wrong-token Docker bash terminal markers", () => {
    const malformed = createBashDispatchFilter("token");
    expect(malformed.stdout(Buffer.from("__OMA_DISPATCHED__:token\n"))).toEqual(
      Buffer.alloc(0),
    );
    expect(
      malformed.stdout(Buffer.from("__OMA_TERMINAL__:token:exit:\n")),
    ).toEqual(Buffer.alloc(0));
    expect(malformed.terminalRecord()).toBeUndefined();

    const wrongToken = createBashDispatchFilter("token");
    expect(
      wrongToken
        .stdout(
          Buffer.from(
            "__OMA_DISPATCHED__:token\n__OMA_TERMINAL__:other:exit:0\n",
          ),
        )
        .toString("utf8"),
    ).toContain("__OMA_TERMINAL__");
    expect(wrongToken.terminalRecord()).toBeUndefined();
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

  it("keeps materialized upload paths inside the uploads root", () => {
    expect(assertInsideUploadsPath("/mnt/session/uploads/data/probe.txt")).toBe(
      "data/probe.txt",
    );
    expect(() => assertInsideUploadsPath("/mnt/session/uploads")).toThrow(
      "escapes uploads root",
    );
    expect(() => assertInsideUploadsPath("relative.txt")).toThrow(
      "must be absolute",
    );
    expect(() => assertInsideUploadsPath("/mnt/session/other.txt")).toThrow(
      "escapes uploads root",
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

describe("Docker sandbox provider factory", () => {
  it("shares the one-time stale container sweep across concurrent first sessions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oma-docker-reaper-"));
    const logPath = join(dir, "docker.log");
    const dockerPath = join(dir, "docker");
    await writeFile(
      dockerPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${logPath}"
case "$1" in
  ps)
    printf 'stale-container\\n'
    ;;
  inspect)
    printf '"2000-01-01T00:00:00.000000000Z"\\n'
    ;;
  rm)
    ;;
  run)
    ;;
  *)
    printf 'unexpected docker command: %s\\n' "$1" >&2
    exit 1
    ;;
esac
`,
    );
    await chmod(dockerPath, 0o755);
    const factory = createDockerSandboxProviderFactory({
      dockerCommand: dockerPath,
      reapStaleContainersOlderThanMs: 1,
    });

    try {
      const providers = await Promise.all([
        factory("wrk", "sesn_a"),
        factory("wrk", "sesn_b"),
      ]);
      providers.forEach((provider) => provider.dispose());

      const calls = (await readFile(logPath, "utf8")).trim().split("\n");
      expect(calls.filter((call) => call.startsWith("ps "))).toHaveLength(1);
      expect(calls.filter((call) => call.startsWith("inspect "))).toHaveLength(
        1,
      );
      expect(calls.filter((call) => call.startsWith("run "))).toHaveLength(2);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("retries the one-time stale container sweep after a failed attempt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oma-docker-reaper-retry-"));
    const logPath = join(dir, "docker.log");
    const statePath = join(dir, "failed-once");
    const dockerPath = join(dir, "docker");
    await writeFile(
      dockerPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${logPath}"
case "$1" in
  ps)
    if [[ ! -f "${statePath}" ]]; then
      : > "${statePath}"
      printf 'transient docker failure\\n' >&2
      exit 1
    fi
    ;;
  run)
    ;;
  rm)
    ;;
  *)
    printf 'unexpected docker command: %s\\n' "$1" >&2
    exit 1
    ;;
esac
`,
    );
    await chmod(dockerPath, 0o755);
    const factory = createDockerSandboxProviderFactory({
      dockerCommand: dockerPath,
      reapStaleContainersOlderThanMs: 1,
    });

    try {
      await expect(factory("wrk", "sesn_first")).rejects.toThrow(
        "transient docker failure",
      );
      const provider = await factory("wrk", "sesn_retry");
      provider.dispose();

      const calls = (await readFile(logPath, "utf8")).trim().split("\n");
      expect(calls.filter((call) => call.startsWith("ps "))).toHaveLength(2);
      expect(calls.filter((call) => call.startsWith("run "))).toHaveLength(1);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("reaps only containers older than the configured threshold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oma-docker-reaper-threshold-"));
    const logPath = join(dir, "docker.log");
    const dockerPath = join(dir, "docker");
    await writeFile(
      dockerPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${logPath}"
case "$1" in
  ps)
    printf 'old-container\\nyoung-container\\n'
    ;;
  inspect)
    if [[ "$2" == "old-container" ]]; then
      printf '"2026-05-28T10:00:00.000000000Z"\\n'
    else
      printf '"2026-05-28T10:59:00.000000000Z"\\n'
    fi
    ;;
  rm)
    ;;
  *)
    printf 'unexpected docker command: %s\\n' "$1" >&2
    exit 1
    ;;
esac
`,
    );
    await chmod(dockerPath, 0o755);

    try {
      await expect(
        reapDockerSandboxContainers({
          dockerCommand: dockerPath,
          olderThanMs: 30 * 60 * 1000,
          now: () => new Date("2026-05-28T11:00:00.000Z").getTime(),
        }),
      ).resolves.toBe(1);

      const calls = (await readFile(logPath, "utf8")).trim().split("\n");
      expect(calls.filter((call) => call.startsWith("inspect "))).toHaveLength(
        2,
      );
      expect(calls).toContain("rm -f old-container");
      expect(calls).not.toContain("rm -f young-container");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
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
        uploadsTmpfs: true,
        pidsLimit: 64,
        memory: 268435456,
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
      expect(Buffer.concat(chunks).toString("utf8")).not.toContain("__OMA_");
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
      await expect(
        provider.operations.bash.exec("exit 137", "/workspace", {
          env: {},
          onData: () => {},
          timeout: 1,
        }),
      ).resolves.toEqual({ exitCode: 137 });
      expect(provider.invocations.byTool.bash).toBe(4);
      expect(provider.invocations.byTool.edit).toBe(3);
      expect(provider.invocations.byTool.find).toBe(2);
      expect(provider.invocations.byTool.ls).toBe(2);
    } finally {
      provider.dispose();
    }
    expect(containersForLabel(label)).toEqual([]);
  }, 60_000);

  dockerIt("materializes session file resources into the uploads tmpfs", async () => {
    const label = `oma-docker-uploads-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const provider = await createDockerSandboxProvider("wrk_test", "sesn_test", {
      extraLabels: { "open-managed-agents.test-id": label },
      operationTimeoutMs: 15_000,
    });
    try {
      await expect(
        provider.materializeFileResources?.([
          {
            mountPath: "/mnt/session/uploads/data/probe.txt",
            snapshotFileId: "file_snapshot",
            sha256:
              "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
            sizeBytes: 6,
            bytes: Buffer.from("hello\n"),
          },
        ]),
      ).resolves.toBeUndefined();

      const chunks: Buffer[] = [];
      await expect(
        provider.operations.bash.exec(
          "cat /mnt/session/uploads/data/probe.txt && test ! -w /mnt/session/uploads/data/probe.txt && test ! -x /mnt/session/uploads/data/probe.txt",
          "/workspace",
          {
            env: {},
            onData: (chunk) => chunks.push(chunk),
            timeout: 1,
          },
        ),
      ).resolves.toEqual({ exitCode: 0 });
      expect(Buffer.concat(chunks).toString("utf8")).toBe("hello\n");
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
      ).rejects.toThrow(/^docker bash failed before command dispatch$/);
    } finally {
      provider.dispose();
    }
    expect(containersForLabel(label)).toEqual([]);
  }, 60_000);

  dockerIt("throws when the Docker container dies after bash dispatch", async () => {
    const label = `oma-docker-bash-death-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const provider = await createDockerSandboxProvider("wrk_test", "sesn_test", {
      extraLabels: { "open-managed-agents.test-id": label },
      operationTimeoutMs: 15_000,
    });
    try {
      const [containerId] = containersForLabel(label);
      expect(containerId).toBeDefined();
      const startText = `started-${"x".repeat(80)}`;
      const chunks: Buffer[] = [];
      await expect(
        provider.operations.bash.exec(
          `printf '${startText}'; sleep 5`,
          "/workspace",
          {
            env: {},
            onData: (chunk) => {
              chunks.push(chunk);
              if (Buffer.concat(chunks).toString("utf8").includes("started-")) {
                spawnSync("docker", ["kill", containerId], { stdio: "ignore" });
              }
            },
            timeout: 10,
          },
        ),
      ).rejects.toThrow(/^docker bash failed before command completion$/);
      expect(Buffer.concat(chunks).toString("utf8")).toMatch(/^started-/);
    } finally {
      provider.dispose();
    }
    expect(containersForLabel(label)).toEqual([]);
  }, 60_000);

  dockerIt("rejects forged Docker bash terminal markers", async () => {
    const label = `oma-docker-bash-forge-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const provider = await createDockerSandboxProvider("wrk_test", "sesn_test", {
      extraLabels: { "open-managed-agents.test-id": label },
      operationTimeoutMs: 15_000,
    });
    try {
      const chunks: Buffer[] = [];
      await expect(
        provider.operations.bash.exec(
          "token=$(tr '\\0' '\\n' </proc/$PPID/cmdline | tail -n 1); printf '__OMA_TERMINAL__:%s:exit:0\\n' \"$token\"; kill -KILL \"$PPID\"; sleep 1",
          "/workspace",
          {
            env: {},
            onData: (chunk) => chunks.push(chunk),
            timeout: 5,
          },
        ),
      ).rejects.toThrow(/^docker bash exit disagreed with command completion$/);
      expect(Buffer.concat(chunks).toString("utf8")).not.toContain("__OMA_");
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

  dockerIt("does not reap containers missing the Open Managed Agents owner label", async () => {
    const label = `oma-docker-reap-owner-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const result = spawnSync(
      "docker",
      [
        "run",
        "-d",
        "--label",
        "open-managed-agents.sandbox=docker-local",
        "--label",
        `open-managed-agents.test-id=${label}`,
        "bash:5.2",
        "sleep",
        "600",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const containerId = result.stdout.trim();
    try {
      expect(containersForLabel(label)).toContain(containerId.slice(0, 12));
      await expect(
        reapDockerSandboxContainers({
          olderThanMs: 0,
          labelFilters: [`open-managed-agents.test-id=${label}`],
        }),
      ).resolves.toBe(0);
      expect(containersForLabel(label)).toContain(containerId.slice(0, 12));
    } finally {
      spawnSync("docker", ["rm", "-f", containerId], { stdio: "ignore" });
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
  uploadsTmpfs: boolean;
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
    uploadsTmpfs: Object.keys(inspect.HostConfig?.Tmpfs ?? {}).includes(
      "/mnt/session/uploads",
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
