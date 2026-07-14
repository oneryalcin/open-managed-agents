import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MICROSANDBOX_MAX_BUFFER,
  DEFAULT_MICROSANDBOX_IMAGE,
  DEFAULT_MICROSANDBOX_OUTPUTS_PATH,
  DEFAULT_MICROSANDBOX_UPLOADS_PATH,
  DEFAULT_MICROSANDBOX_WORKSPACE,
  NodeMicrosandboxCli,
  assertInsideMicrosandboxOutputPath,
  assertInsideMicrosandboxUploadsPath,
  assertInsideMicrosandboxWorkspace,
  buildMicrosandboxBashCommand,
  buildMicrosandboxFileAccessCommand,
  buildMicrosandboxCmaGrepPreflightCommand,
  buildMicrosandboxCmaGrepPatternCheckCommand,
  buildMicrosandboxCmaGrepCandidateEnumerationCommand,
  buildMicrosandboxCmaGrepSearchCommand,
  buildMicrosandboxGlobEnumerationCommand,
  buildMicrosandboxKillProcessGroupCommand,
  buildMicrosandboxMkdirCommand,
  buildMicrosandboxOutputListingCommand,
  buildMicrosandboxReadFileCommand,
  buildMicrosandboxReaddirCommand,
  buildMicrosandboxStatCommand,
  buildMicrosandboxWriteFileCommand,
  buildMicrosandboxCopyArgs,
  buildMicrosandboxCreateArgs,
  buildMicrosandboxExecArgs,
  buildMicrosandboxInspectArgs,
  buildMicrosandboxListArgs,
  buildMicrosandboxRemoveArgs,
  buildMicrosandboxShellExecArgs,
  buildMicrosandboxStartArgs,
  buildMicrosandboxStopArgs,
  buildMicrosandboxVolumeCreateArgs,
  buildMicrosandboxVolumeInspectArgs,
  buildMicrosandboxVolumeListArgs,
  buildMicrosandboxVolumeRemoveArgs,
  createMicrosandboxSandboxProvider,
  createMicrosandboxSandboxProviderFactory,
  createMicrosandboxBashDispatchFilter,
  directoryNamesPrunedByIgnoreGlobs,
  execMicrosandboxCommand,
  execMicrosandboxCommandSync,
  microsandboxCliEnv,
  microsandboxPathRef,
  reapMicrosandboxSandboxes,
  microsandboxResourceName,
  type MicrosandboxCli,
  type MicrosandboxCliExecOptions,
  type MicrosandboxCliResult,
} from "../microsandbox.ts";
import type { SandboxProvider } from "../provider.ts";

describe("microsandbox command builders", () => {
  it("builds create args with explicit volume workspace and no-network policy", () => {
    const args = buildMicrosandboxCreateArgs({
      sandboxName: "oma-sbx",
      volumeName: "oma-vol",
      labels: { "oma.probe": "unit", "owner": "open-managed-agents" },
    });

    expect(args).toEqual([
      "create",
      DEFAULT_MICROSANDBOX_IMAGE,
      "--name",
      "oma-sbx",
      "--mount-named",
      `oma-vol:${DEFAULT_MICROSANDBOX_WORKSPACE}`,
      "--workdir",
      DEFAULT_MICROSANDBOX_WORKSPACE,
      "--no-net",
      "--tmpfs",
      `${DEFAULT_MICROSANDBOX_UPLOADS_PATH}:64M:nosuid,nodev,noexec`,
      "--tmpfs",
      `${DEFAULT_MICROSANDBOX_OUTPUTS_PATH}:100M:nosuid,nodev,noexec`,
      "--cpus",
      "1",
      "--memory",
      "512M",
      "--oci-upper-size",
      "1G",
      "--max-duration",
      "2h",
      "--security",
      "restricted",
      "--pull",
      "if-missing",
      "--quiet",
      "--label",
      "oma.probe=unit",
      "--label",
      "owner=open-managed-agents",
    ]);
    expect(args).not.toContain("--secret");
    expect(args).not.toContain("--env");
  });

  it("builds lifecycle and volume args without provider side effects", () => {
    expect(buildMicrosandboxVolumeCreateArgs("oma-vol")).toEqual([
      "volume",
      "create",
      "--name",
      "oma-vol",
    ]);
    expect(buildMicrosandboxVolumeRemoveArgs("oma-vol")).toEqual([
      "volume",
      "remove",
      "oma-vol",
    ]);
    expect(buildMicrosandboxVolumeListArgs()).toEqual([
      "volume",
      "list",
      "--format",
      "json",
    ]);
    expect(buildMicrosandboxVolumeInspectArgs("oma-vol")).toEqual([
      "volume",
      "inspect",
      "oma-vol",
    ]);
    expect(buildMicrosandboxStopArgs("oma-sbx")).toEqual(["stop", "oma-sbx"]);
    expect(buildMicrosandboxStartArgs("oma-sbx")).toEqual(["start", "oma-sbx"]);
    expect(buildMicrosandboxRemoveArgs("oma-sbx")).toEqual([
      "remove",
      "--force",
      "oma-sbx",
    ]);
  });

  it("builds exec, stream, copy, and inspect args", () => {
    expect(
      buildMicrosandboxExecArgs({
        sandboxName: "oma-sbx",
        command: ["/bin/sh", "-lc", "pwd"],
        workdir: DEFAULT_MICROSANDBOX_WORKSPACE,
        timeout: "1s",
        stream: true,
      }),
    ).toEqual([
      "exec",
      "--stream",
      "--timeout",
      "1s",
      "--workdir",
      DEFAULT_MICROSANDBOX_WORKSPACE,
      "oma-sbx",
      "--",
      "/bin/sh",
      "-lc",
      "pwd",
    ]);
    expect(
      buildMicrosandboxShellExecArgs({
        sandboxName: "oma-sbx",
        script: "cat \"$1\"",
        args: [`${DEFAULT_MICROSANDBOX_UPLOADS_PATH}/input.txt`],
      }),
    ).toEqual([
      "exec",
      "oma-sbx",
      "--",
      "/bin/sh",
      "-lc",
      "cat \"$1\"",
      "sh",
      `${DEFAULT_MICROSANDBOX_UPLOADS_PATH}/input.txt`,
    ]);
    expect(
      buildMicrosandboxCopyArgs(
        "/tmp/input.txt",
        microsandboxPathRef("oma-sbx", `${DEFAULT_MICROSANDBOX_UPLOADS_PATH}/x`),
      ),
    ).toEqual([
      "copy",
      "/tmp/input.txt",
      `oma-sbx:${DEFAULT_MICROSANDBOX_UPLOADS_PATH}/x`,
    ]);
    expect(
      buildMicrosandboxCopyArgs(
        microsandboxPathRef(
          "oma-sbx",
          `${DEFAULT_MICROSANDBOX_OUTPUTS_PATH}/out.txt`,
        ),
        "/tmp/out.txt",
      ),
    ).toEqual([
      "copy",
      `oma-sbx:${DEFAULT_MICROSANDBOX_OUTPUTS_PATH}/out.txt`,
      "/tmp/out.txt",
    ]);
    expect(buildMicrosandboxInspectArgs("oma-sbx")).toEqual([
      "inspect",
      "oma-sbx",
      "--format",
      "json",
    ]);
    expect(buildMicrosandboxListArgs(["oma.owner=open-managed-agents"])).toEqual(
      [
        "list",
        "--format",
        "json",
        "--label",
        "oma.owner=open-managed-agents",
      ],
    );
  });

  it("builds CMA grep commands with LC_ALL=C and token ownership", () => {
    const preflight = buildMicrosandboxCmaGrepPreflightCommand();
    expect(preflight.script).toContain("LC_ALL=C grep -E -q");
    expect(preflight.script).toContain("grep -Iq");
    expect(preflight.script).toContain("read -r -d");
    expect(buildMicrosandboxCmaGrepPatternCheckCommand("[abc]").script).toContain("LC_ALL=C grep -E -q");
    expect(buildMicrosandboxCmaGrepCandidateEnumerationCommand("/workspace", "oma-grep-token").script)
      .toContain("find \"$1\" -type f -print0");
    expect(buildMicrosandboxCmaGrepCandidateEnumerationCommand("/workspace", "oma-grep-token").script)
      .toContain("[ -f \"$1\" ]");
    const command = buildMicrosandboxCmaGrepSearchCommand("/workspace", "oma-grep-token", "needle");
    expect(command.args).toEqual(["/workspace", "oma-grep-token", "needle"]);
    expect(command.script).toContain("OMA_GREP_OWNER=$2");
    expect(command.script).toContain("__OMA_GREP_READY__");
    expect(command.script).toContain("while IFS= read -r -d");
    expect(command.script).toContain("grep -Iq");
    expect(command.script).toContain("grep -E -q");
  });

  it("generates stable provider-owned resource names with a uniqueness suffix", () => {
    expect(
      microsandboxResourceName({
        workspaceId: "wrk_ABC",
        sessionId: "sesn_XYZ",
        purpose: "workspace volume",
        now: () => 1_779_999_000_000,
        random: () => 0.123456789,
      }),
    ).toEqual("oma-wrk_abc-sesn_xyz-workspace-volume-mppxg2io-4fzzzx");
  });

  it("builds file-operation commands as data", () => {
    expect(buildMicrosandboxFileAccessCommand("/workspace/a.txt", "read")).toEqual({
      script: "test -r \"$1\" -a -f \"$1\"",
      args: ["/workspace/a.txt"],
    });
    expect(buildMicrosandboxFileAccessCommand("/workspace/a.txt", "edit")).toEqual({
      script: "test -r \"$1\" -a -w \"$1\" -a -f \"$1\"",
      args: ["/workspace/a.txt"],
    });
    expect(buildMicrosandboxReadFileCommand("/workspace/a.txt")).toEqual({
      script: "cat \"$1\"",
      args: ["/workspace/a.txt"],
    });
    expect(buildMicrosandboxWriteFileCommand("/workspace/a.txt", "hello")).toEqual({
      script: "cat > \"$1\"",
      args: ["/workspace/a.txt"],
      input: "hello",
    });
    expect(buildMicrosandboxMkdirCommand("/workspace/src")).toEqual({
      script: "mkdir -p \"$1\"",
      args: ["/workspace/src"],
    });
    expect(buildMicrosandboxStatCommand("/workspace/src")).toEqual({
      script:
        "if [ -d \"$1\" ]; then printf directory; elif [ -e \"$1\" ]; then printf file; else exit 1; fi",
      args: ["/workspace/src"],
    });
    expect(buildMicrosandboxReaddirCommand("/workspace/src")).toEqual({
      script: "ls -1A \"$1\"",
      args: ["/workspace/src"],
    });
    expect(buildMicrosandboxGlobEnumerationCommand("/workspace")).toEqual({
      script:
        "cd \"$1\"\nshift\nif [ \"$#\" -eq 0 ]; then\n  find . -type f | sed 's#^./##' | sort\nelse\n  find . \\( -type d \\( \"$@\" \\) -prune \\) -o -type f -print | sed 's#^./##' | sort\nfi",
      args: ["/workspace"],
    });
    expect(
      buildMicrosandboxGlobEnumerationCommand("/workspace", [
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
      buildMicrosandboxOutputListingCommand("/mnt/session/outputs", {
        maxFiles: 7,
        maxFileBytes: 1024,
        maxBytes: 4096,
      }),
    ).toMatchObject({
      args: ["/mnt/session/outputs", "7", "1024", "4096"],
    });
    expect(
      directoryNamesPrunedByIgnoreGlobs([
        "**/node_modules/**",
        "dist/**",
        "*.ts",
      ]),
    ).toEqual(["dist", "node_modules"]);
  });

  it("builds bash commands with guest process-group timeout and pid tracking", () => {
    const command = buildMicrosandboxBashCommand(
      "sleep 5",
      1,
      "/workspace/.oma-msb-exec-test.pid",
      "token",
    );

    expect(command.args).toEqual([
      "/workspace/.oma-msb-exec-test.pid",
      "1",
      "sleep 5",
      "token",
    ]);
    expect(command.script).toContain("__OMA_DISPATCHED__");
    expect(command.script).toContain("__OMA_TERMINAL__");
    expect(command.script).toContain("setsid /bin/sh -lc");
    expect(command.script).toContain("kill -KILL \"-$pid\"");
    expect(buildMicrosandboxKillProcessGroupCommand("/workspace/pid")).toMatchObject({
      args: ["/workspace/pid"],
    });
  });

  it("filters microsandbox bash dispatch and terminal markers", () => {
    const filter = createMicrosandboxBashDispatchFilter("token");

    expect(filter.chunk(Buffer.from("__OMA_DIS"))).toEqual(Buffer.alloc(0));
    expect(filter.chunk(Buffer.from("PATCHED__:token\nhello"))).toEqual(
      Buffer.from("hello"),
    );
    expect(
      filter.chunk(Buffer.from("__OMA_TERMINAL__:token:timeout:137\n")),
    ).toEqual(Buffer.alloc(0));
    expect(filter.dispatchSeen()).toBe(true);
    expect(filter.terminalRecord()).toEqual({ kind: "timeout", exitCode: 137 });
  });

  it("keeps microsandbox paths inside provider-owned roots", () => {
    expect(assertInsideMicrosandboxWorkspace("/workspace/src/../a.txt")).toBe(
      "/workspace/a.txt",
    );
    expect(() => assertInsideMicrosandboxWorkspace("relative.txt")).toThrow(
      "must be absolute",
    );
    expect(() => assertInsideMicrosandboxWorkspace("/etc/passwd")).toThrow(
      "escapes workspace",
    );
    expect(
      assertInsideMicrosandboxUploadsPath(
        "/mnt/session/uploads/data/probe.txt",
      ),
    ).toBe("data/probe.txt");
    expect(() =>
      assertInsideMicrosandboxUploadsPath("/mnt/session/uploads"),
    ).toThrow("escapes uploads root");
    expect(assertInsideMicrosandboxOutputPath("/mnt/session/outputs/a.txt")).toBe(
      "/mnt/session/outputs/a.txt",
    );
    expect(() => assertInsideMicrosandboxOutputPath("../escape.txt")).toThrow(
      "must be absolute",
    );
    expect(() =>
      assertInsideMicrosandboxOutputPath("/mnt/session/outputs/../escape.txt"),
    ).toThrow("escapes outputs root");
  });

  it("rejects flag-like generated resource arguments", () => {
    expect(() => buildMicrosandboxVolumeRemoveArgs("-oops")).toThrow(
      "cannot be empty or start",
    );
    expect(() =>
      buildMicrosandboxCreateArgs({
        sandboxName: "oma-sbx",
        volumeName: "oma-vol",
        labels: { "-flag": "value" },
      }),
    ).toThrow("labels cannot be empty");
  });
});

describe("microsandbox CLI adapter", () => {
  it("prepends the current Node directory so msb's env-node wrapper works", async () => {
    const nodeDir = dirname(process.execPath);
    const env = microsandboxCliEnv(
      {
        PATH: "/usr/bin:/bin",
        HOME: "/tmp/home",
        AWS_SECRET_ACCESS_KEY: "secret",
      },
      { nodeExecutable: process.execPath },
    );

    expect(env.PATH?.split(":").at(0)).toBe(nodeDir);
    expect(env.HOME).toBe("/tmp/home");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();

    const cli = new NodeMicrosandboxCli({
      command: "/usr/bin/env",
      env: { PATH: "/usr/bin:/bin", AWS_SECRET_ACCESS_KEY: "secret" },
      nodeExecutable: process.execPath,
    });
    const result = await cli.exec(["node", "--version"], {
      env: { PATH: "/usr/bin:/bin", OPENAI_API_KEY: "secret" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.toString("utf8").trim()).toBe(process.version);
  });

  it("trusts process exit status instead of parsing guest stdout", async () => {
    const result = await execMicrosandboxCommand("/bin/sh", [
      "-c",
      "printf '__OMA_TERMINAL__:forged:exit:0\\n'; exit 7",
    ]);

    expect(result.status).toBe(7);
    expect(result.stdout.toString("utf8")).toContain("__OMA_TERMINAL__");
  });

  it("rejects async exec when output exceeds maxBuffer", async () => {
    await expect(
      execMicrosandboxCommand(
        "/bin/sh",
        ["-c", "printf 12345"],
        { maxBuffer: 3 },
      ),
    ).rejects.toThrow("Microsandbox command output exceeded 3 bytes");
  });

  it("can kill a hung child process at the adapter boundary", async () => {
    const result = await execMicrosandboxCommand(
      "/bin/sh",
      ["-c", "sleep 10"],
      { timeoutMs: 10 },
    );

    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGKILL");
  });

  it("rejects async exec spawn errors and aborts", async () => {
    await expect(
      execMicrosandboxCommand("/definitely/not/a/command", []),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const controller = new AbortController();
    const promise = execMicrosandboxCommand("/bin/sh", ["-c", "sleep 10"], {
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("passes timeout and maxBuffer through the sync teardown path", () => {
    expect(() =>
      execMicrosandboxCommandSync(
        "/bin/sh",
        ["-c", "sleep 1"],
        { timeoutMs: 10 },
      ),
    ).toThrow("ETIMEDOUT");
    expect(() =>
      execMicrosandboxCommandSync(
        "/bin/sh",
        ["-c", "printf 12345"],
        { maxBuffer: 3 },
      ),
    ).toThrow("ENOBUFS");
  });

  it("uses the module maxBuffer default for sync commands", () => {
    const result = execMicrosandboxCommandSync(process.execPath, [
      "-e",
      "process.stdout.write(Buffer.alloc(2 * 1024 * 1024))",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toHaveLength(2 * 1024 * 1024);
  });

  it("uses a bounded async output buffer by default", () => {
    expect(DEFAULT_MICROSANDBOX_MAX_BUFFER).toBeGreaterThan(0);
  });

  it("records call order and can fail scripted calls in tests", async () => {
    const cli = new RecordingMicrosandboxCli();
    cli.queueExec(ok("created-volume"));
    cli.queueExec(fail("create failed"));
    cli.queueExecSync(ok("removed-volume"));

    await cli.exec(buildMicrosandboxVolumeCreateArgs("oma-vol"));
    await expect(
      cli.exec(
        buildMicrosandboxCreateArgs({
          sandboxName: "oma-sbx",
          volumeName: "oma-vol",
        }),
      ),
    ).rejects.toThrow("create failed");
    cli.execSync(buildMicrosandboxVolumeRemoveArgs("oma-vol"));

    expect(cli.calls.map((call) => call.args.join(" "))).toEqual([
      "volume create --name oma-vol",
      `create ${DEFAULT_MICROSANDBOX_IMAGE} --name oma-sbx --mount-named oma-vol:/workspace --workdir /workspace --no-net --tmpfs /mnt/session/uploads:64M:nosuid,nodev,noexec --tmpfs /mnt/session/outputs:100M:nosuid,nodev,noexec --cpus 1 --memory 512M --oci-upper-size 1G --max-duration 2h --security restricted --pull if-missing --quiet`,
      "volume remove oma-vol",
    ]);
    expect(cli.calls.map((call) => call.mode)).toEqual([
      "async",
      "async",
      "sync",
    ]);
  });
});

describe("microsandbox sandbox provider", () => {
  it("creates an explicit workspace volume and disposes sandbox before volume", async () => {
    const cli = new RecordingMicrosandboxCli();
    cli.queueExec(ok("volume"));
    cli.queueExec(ok("sandbox"));
    cli.queueExecSync(ok("removed-sandbox"));
    cli.queueExecSync(ok("removed-volume"));

    const provider = await createMicrosandboxSandboxProvider("wrk", "sesn", {
      cli,
      now: () => 1_779_999_000_000,
      random: () => 0.123456789,
    });
    expect(provider.cwd).toBe(DEFAULT_MICROSANDBOX_WORKSPACE);
    expect(provider.toolNames.has("bash")).toBe(true);

    provider.dispose();

    const calls = cli.calls.map((call) => call.args);
    expect(calls[0]).toEqual([
      "volume",
      "create",
      "--name",
      "oma-wrk-sesn-workspace-volume-mppxg2io-4fzzzx",
    ]);
    expect(calls[1]).toContain("--no-net");
    expect(calls.at(-2)).toEqual([
      "remove",
      "--force",
      "oma-wrk-sesn-sandbox-mppxg2io-4fzzzx",
    ]);
    expect(calls.at(-1)).toEqual([
      "volume",
      "remove",
      "oma-wrk-sesn-workspace-volume-mppxg2io-4fzzzx",
    ]);
  });

  it("removes a created volume when sandbox creation fails", async () => {
    const cli = new RecordingMicrosandboxCli();
    cli.queueExec(ok("volume"));
    cli.queueExec(fail("create failed"));
    cli.queueExecSync(ok("removed-volume"));

    await expect(
      createMicrosandboxSandboxProvider("wrk", "sesn", {
        cli,
        now: () => 1_779_999_000_000,
        random: () => 0.123456789,
      }),
    ).rejects.toThrow("create failed");

    expect(cli.calls.map((call) => call.args.join(" "))).toEqual([
      "volume create --name oma-wrk-sesn-workspace-volume-mppxg2io-4fzzzx",
      `create ${DEFAULT_MICROSANDBOX_IMAGE} --name oma-wrk-sesn-sandbox-mppxg2io-4fzzzx --mount-named oma-wrk-sesn-workspace-volume-mppxg2io-4fzzzx:/workspace --workdir /workspace --no-net --tmpfs /mnt/session/uploads:64M:nosuid,nodev,noexec --tmpfs /mnt/session/outputs:100M:nosuid,nodev,noexec --cpus 1 --memory 512M --oci-upper-size 1G --max-duration 2h --security restricted --pull if-missing --quiet --label open-managed-agents.sandbox=microsandbox-local --label open-managed-agents.owner=open-managed-agents --label open-managed-agents.workspace-id=wrk --label open-managed-agents.session-id=sesn --label open-managed-agents.created-at=2026-05-28T20:10:00.000Z`,
      "remove --force oma-wrk-sesn-sandbox-mppxg2io-4fzzzx",
      "volume remove oma-wrk-sesn-workspace-volume-mppxg2io-4fzzzx",
    ]);
  });

  it("runs file operations through bounded microsandbox exec commands", async () => {
    const cli = new RecordingMicrosandboxCli();
    cli.queueExec(ok("volume"));
    cli.queueExec(ok("sandbox"));
    cli.queueExec(ok(""));
    cli.queueExec(ok(""));
    cli.queueExec(ok("hello"));
    cli.queueExec(ok("file"));
    cli.queueExec(ok("README.md\nsrc\n"));
    cli.queueExec(ok("src/index.ts\n"));
    cli.queueExec(ok("__OMA_GLOB_READY__\0src/index.ts\0"));
    cli.queueExec(ok(""));
    cli.queueExec(ok(""));
    cli.queueExec(ok("__OMA_GREP_READY__\0src/index.ts\0"));
    cli.queueExec(ok(""));
    cli.queueExec(ok("__OMA_GREP_READY__\0src/index.ts\0"));
    cli.queueExec(ok(""));
    cli.queueExecSync(ok(""));
    cli.queueExecSync(ok(""));
    const provider = await createMicrosandboxSandboxProvider("wrk", "sesn", {
      cli,
      operationTimeoutMs: 2500,
      now: () => 1_779_999_000_000,
      random: () => 0.123456789,
    });

    await provider.operations.write.mkdir("/workspace/src");
    await provider.operations.write.writeFile("/workspace/README.md", "hello");
    await expect(
      provider.operations.read.readFile("/workspace/README.md"),
    ).resolves.toEqual(Buffer.from("hello"));
    await expect(provider.operations.ls.stat("/workspace/src")).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
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
    await expect(provider.operations.glob.glob({
      pattern: "*.ts",
      cwd: "/workspace",
      signal: new AbortController().signal,
      maxMatches: 100,
      maxRawBytes: 1024 * 1024,
      maxOutputBytes: 64 * 1024,
      timeoutMs: 10_000,
    })).resolves.toEqual(["/workspace/src/index.ts"]);
    await expect(provider.operations.grep.grep({
      pattern: "value",
      cwd: "/workspace",
      glob: "*.ts",
      context: 1,
      headLimit: 100,
      signal: new AbortController().signal,
      maxRawBytes: 1024 * 1024,
      maxOutputBytes: 64 * 1024,
      timeoutMs: 10_000,
    })).resolves.toEqual(["/workspace/src/index.ts"]);
    provider.dispose();

    expect(cli.calls.slice(2, 8).map((call) => call.args[0])).toEqual([
      "exec",
      "exec",
      "exec",
      "exec",
      "exec",
      "exec",
    ]);
    expect(cli.calls[2]?.opts?.timeoutMs).toBe(4500);
    expect(cli.calls[3]?.args).toContain("--stream");
    expect(cli.calls[3]?.opts?.input).toBe("hello");
    expect(provider.invocations.byTool.write).toBe(2);
    expect(provider.invocations.byTool.read).toBe(1);
    expect(provider.invocations.byTool.ls).toBe(2);
    expect(provider.invocations.byTool.find).toBe(1);
    expect(provider.invocations.byTool.glob).toBe(1);
    expect(provider.invocations.byTool.grep).toBe(1);
    const globCall = cli.calls.find((call) =>
      call.args.some((arg) => arg.includes("find . -type f -print0"))
    );
    expect(globCall?.args).toContain("--stream");
  });

  it("terminates CMA glob enumeration at 100 matches and forwards caller abort", async () => {
    const cli = new RecordingMicrosandboxCli();
    cli.queueExec(ok("volume"));
    cli.queueExec(ok("sandbox"));
    let operationSignal: AbortSignal | undefined;
    cli.queueExec((opts) => {
      operationSignal = opts?.signal;
      const records = Array.from(
        { length: 150 },
        (_, index) => `./file-${String(index).padStart(3, "0")}.md\0`,
      ).join("");
      opts?.onStdout?.(Buffer.from(`__OMA_GLOB_READY__\0${records}`));
      return okResult("");
    });
    const provider = await createMicrosandboxSandboxProvider("wrk", "sesn", {
      cli,
      now: () => 1_779_999_000_000,
      random: () => 0.123456789,
    });

    const matches = await provider.operations.glob.glob({
      pattern: "*.md",
      cwd: "/workspace",
      signal: new AbortController().signal,
      maxMatches: 100,
      maxRawBytes: 1024 * 1024,
      maxOutputBytes: 64 * 1024,
      timeoutMs: 10_000,
    });
    expect(matches).toHaveLength(100);
    expect(operationSignal?.aborted).toBe(true);

    const invoke = (overrides: Partial<Parameters<typeof provider.operations.glob.glob>[0]> = {}) =>
      provider.operations.glob.glob({
        pattern: "*.md",
        cwd: "/workspace",
        signal: new AbortController().signal,
        maxMatches: 100,
        maxRawBytes: 1024 * 1024,
        maxOutputBytes: 64 * 1024,
        timeoutMs: 10_000,
        ...overrides,
      });
    cli.queueExec((opts) => {
      opts?.onStdout?.(Buffer.from(`__OMA_GLOB_READY__\0./${"x".repeat(32)}.txt\0`));
      return okResult("");
    });
    cli.queueExec(ok(""));
    await expect(invoke({ maxRawBytes: 8 })).rejects.toThrow("raw bytes");
    cli.queueExec((opts) => {
      opts?.onStdout?.(Buffer.from("__OMA_GLOB_READY__\0./a.md\0"));
      return okResult("");
    });
    cli.queueExec(ok(""));
    await expect(invoke({ maxOutputBytes: 8 })).rejects.toThrow("output exceeds");
    cli.queueExec((opts) => {
      opts?.onStdout?.(Buffer.from("__OMA_GLOB_READY__\0"));
      throw new Error("microsandbox timeout");
    });
    cli.queueExec(ok(""));
    await expect(invoke({ timeoutMs: 1 })).rejects.toThrow("timeout");

    const abortDuringCleanup = new AbortController();
    cli.queueExec(ok("__OMA_GLOB_READY__\0"));
    cli.queueExec(() => {
      abortDuringCleanup.abort();
      return okResult("");
    });
    await expect(invoke({ signal: abortDuringCleanup.signal }))
      .rejects.toThrow("Operation aborted");

    const aborted = new AbortController();
    aborted.abort();
    await expect(provider.operations.glob.glob({
      pattern: "*.md",
      cwd: "/workspace",
      signal: aborted.signal,
      maxMatches: 100,
      maxRawBytes: 1024 * 1024,
      maxOutputBytes: 64 * 1024,
      timeoutMs: 10_000,
    })).rejects.toThrow("Operation aborted");
    expect(cli.calls).toHaveLength(12);
    provider.dispose();
  });

  it("bounds and cleans up CMA grep lifecycle paths", async () => {
    const cli = new RecordingMicrosandboxCli();
    cli.queueExec(ok("volume"));
    cli.queueExec(ok("sandbox"));
    const provider = await createMicrosandboxSandboxProvider("wrk", "sesn", {
      cli,
      now: () => 1_779_999_000_000,
      random: () => 0.123456789,
    });

    const enqueueGrep = (opts: {
      candidates?: string;
      search?: string | ((opts: MicrosandboxCliExecOptions | undefined) => MicrosandboxCliResult);
      enumCleanup?: string | ((opts: MicrosandboxCliExecOptions | undefined) => MicrosandboxCliResult);
      searchCleanup?: string | ((opts: MicrosandboxCliExecOptions | undefined) => MicrosandboxCliResult);
    }) => {
      cli.queueExec(ok(""));
      cli.queueExec(typeof opts.candidates === "string"
        ? ok(`__OMA_GREP_READY__\0${opts.candidates}`)
        : ok("__OMA_GREP_READY__\0./a.md\0"));
      cli.queueExec(typeof opts.enumCleanup === "function"
        ? opts.enumCleanup
        : ok(opts.enumCleanup ?? ""));
      cli.queueExec(typeof opts.search === "function"
        ? opts.search
        : ok(`__OMA_GREP_READY__\0${opts.search ?? "./a.md\0"}`));
      cli.queueExec(typeof opts.searchCleanup === "function"
        ? opts.searchCleanup
        : ok(opts.searchCleanup ?? ""));
    };
    const enqueueGrepEnumerationOnly = (candidates: string) => {
      cli.queueExec(ok(""));
      cli.queueExec(ok(`__OMA_GREP_READY__\0${candidates}`));
      cli.queueExec(ok(""));
    };
    const invoke = (overrides: Partial<Parameters<typeof provider.operations.grep.grep>[0]> = {}) =>
      provider.operations.grep.grep({
        pattern: "needle",
        cwd: "/workspace",
        glob: "*.md",
        context: 0,
        headLimit: 100,
        signal: new AbortController().signal,
        maxRawBytes: 1024 * 1024,
        maxOutputBytes: 64 * 1024,
        timeoutMs: 10_000,
        ...overrides,
      });

    enqueueGrep({ candidates: "./a.md\0./b.txt\0", search: "./a.md\0" });
    await expect(invoke()).resolves.toEqual(["/workspace/a.md"]);
    expect(cli.calls.find((call) => call.opts?.input instanceof Buffer)?.opts?.input)
      .toEqual(Buffer.from("a.md\0"));

    enqueueGrepEnumerationOnly(`./${"x".repeat(32)}.md\0`);
    await expect(invoke({ maxRawBytes: 8 })).rejects.toThrow("raw bytes");

    enqueueGrep({ candidates: "./long-name.md\0", search: "./long-name.md\0" });
    await expect(invoke({ maxOutputBytes: 8 })).rejects.toThrow("output exceeds");

    enqueueGrep({
      candidates: "./a.md\0",
      search: (opts) => {
        opts?.onStdout?.(Buffer.from("__OMA_GREP_READY__\0"));
        throw new Error("microsandbox grep timeout");
      },
    });
    await expect(invoke({ timeoutMs: 1 })).rejects.toThrow("grep timeout");

    const abortDuringCleanup = new AbortController();
    enqueueGrep({
      candidates: "./a.md\0",
      search: "__OMA_GREP_READY__\0./a.md\0",
      searchCleanup: () => {
        abortDuringCleanup.abort();
        return okResult("");
      },
    });
    await expect(invoke({ signal: abortDuringCleanup.signal }))
      .rejects.toThrow("Operation aborted");

    const poisoned = new RecordingMicrosandboxCli();
    poisoned.queueExec(ok("volume"));
    poisoned.queueExec(ok("sandbox"));
    poisoned.queueExec(ok(""));
    poisoned.queueExec(failAbort());
    poisoned.queueExec(ok("removed-sandbox"));
    const poisonedProvider = await createMicrosandboxSandboxProvider("wrk", "sesn_poison", {
      cli: poisoned,
      now: () => 1_779_999_000_000,
      random: () => 0.123456789,
    });
    await expect(poisonedProvider.operations.grep.grep({
      pattern: "needle",
      cwd: "/workspace",
      context: 0,
      headLimit: 100,
      signal: new AbortController().signal,
      maxRawBytes: 1024 * 1024,
      maxOutputBytes: 64 * 1024,
      timeoutMs: 10_000,
    })).rejects.toThrow("aborted");
    expect(poisonedProvider.isPoisoned?.()).toBe(true);

    const cleanupFail = new RecordingMicrosandboxCli();
    cleanupFail.queueExec(ok("volume"));
    cleanupFail.queueExec(ok("sandbox"));
    cleanupFail.queueExec(ok(""));
    cleanupFail.queueExec(ok("__OMA_GREP_READY__\0./a.md\0"));
    cleanupFail.queueExec(ok(""));
    cleanupFail.queueExec(ok("__OMA_GREP_READY__\0./a.md\0"));
    cleanupFail.queueExec(fail("cleanup failed"));
    cleanupFail.queueExec(ok("removed-sandbox"));
    const cleanupProvider = await createMicrosandboxSandboxProvider("wrk", "sesn_cleanup", {
      cli: cleanupFail,
      now: () => 1_779_999_000_000,
      random: () => 0.123456789,
    });
    await expect(cleanupProvider.operations.grep.grep({
      pattern: "needle",
      cwd: "/workspace",
      context: 0,
      headLimit: 100,
      signal: new AbortController().signal,
      maxRawBytes: 1024 * 1024,
      maxOutputBytes: 64 * 1024,
      timeoutMs: 10_000,
    })).rejects.toThrow("cleanup failed");
    expect(cleanupProvider.isPoisoned?.()).toBe(true);

    provider.dispose();
  });

  it("poisons the sandbox when glob dispatch fails before readiness", async () => {
    const cli = new RecordingMicrosandboxCli();
    cli.queueExec(ok("volume"));
    cli.queueExec(ok("sandbox"));
    const abort = new AbortController();
    cli.queueExec(() => {
      abort.abort();
      const error = new Error("aborted before readiness");
      error.name = "AbortError";
      throw error;
    });
    cli.queueExec(ok("removed-sandbox"));
    cli.queueExecSync(ok("removed-volume"));
    const provider = await createMicrosandboxSandboxProvider("wrk", "sesn", {
      cli,
      now: () => 1_779_999_000_000,
      random: () => 0.123456789,
    });

    await expect(provider.operations.glob.glob({
      pattern: "*.md",
      cwd: "/workspace",
      signal: abort.signal,
      maxMatches: 100,
      maxRawBytes: 1024,
      maxOutputBytes: 1024,
      timeoutMs: 10_000,
    })).rejects.toThrow("Operation aborted");
    await expect(provider.operations.read.readFile("/workspace/a.md"))
      .rejects.toThrow("disposed");
    expect(cli.calls.filter((call) => call.mode === "sync")).toHaveLength(1);
  });

  it("poisons pre-readiness timeouts and retries failed checked removal on dispose", async () => {
    const cli = new RecordingMicrosandboxCli();
    cli.queueExec(ok("volume"));
    cli.queueExec(ok("sandbox"));
    cli.queueExec(fail("transport timeout before readiness"));
    cli.queueExec(() => okResult("", "remove failed", 1));
    cli.queueExecSync(ok("removed-sandbox-on-retry"));
    cli.queueExecSync(ok("removed-volume-on-retry"));
    const provider = await createMicrosandboxSandboxProvider("wrk", "sesn", {
      cli,
      now: () => 1_779_999_000_000,
      random: () => 0.123456789,
    });

    await expect(provider.operations.glob.glob({
      pattern: "*.md",
      cwd: "/workspace",
      signal: new AbortController().signal,
      maxMatches: 100,
      maxRawBytes: 1024,
      maxOutputBytes: 1024,
      timeoutMs: 1,
    })).rejects.toThrow("Failed to remove poisoned microsandbox");
    expect(provider.isPoisoned?.()).toBe(true);
    await expect(provider.operations.read.readFile("/workspace/a.md"))
      .rejects.toThrow("disposed");

    provider.dispose();
    expect(cli.calls.filter((call) => call.mode === "sync")).toHaveLength(2);
  });

  it("poisons the provider when post-readiness glob cleanup fails", async () => {
    const cli = new RecordingMicrosandboxCli();
    cli.queueExec(ok("volume"));
    cli.queueExec(ok("sandbox"));
    cli.queueExec((opts) => {
      opts?.onStdout?.(Buffer.from("__OMA_GLOB_READY__\0"));
      return okResult("");
    });
    cli.queueExec(fail("cleanup failed"));
    cli.queueExec(ok("removed-sandbox"));
    const provider = await createMicrosandboxSandboxProvider("wrk", "sesn", {
      cli,
      now: () => 1_779_999_000_000,
      random: () => 0.123456789,
    });

    await expect(provider.operations.glob.glob({
      pattern: "*.md",
      cwd: "/workspace",
      signal: new AbortController().signal,
      maxMatches: 100,
      maxRawBytes: 1024,
      maxOutputBytes: 1024,
      timeoutMs: 10_000,
    })).rejects.toThrow("cleanup failed");
    expect(provider.isPoisoned?.()).toBe(true);
    await expect(provider.operations.read.readFile("/workspace/a.md"))
      .rejects.toThrow("disposed");

    provider.dispose();
    expect(cli.calls.filter((call) => call.mode === "sync")).toHaveLength(1);
  });

  it("keeps the sandbox healthy when a missing glob path fails after readiness", async () => {
    const cli = new RecordingMicrosandboxCli();
    cli.queueExec(ok("volume"));
    cli.queueExec(ok("sandbox"));
    cli.queueExec((opts) => {
      opts?.onStdout?.(Buffer.from("__OMA_GLOB_READY__\0"));
      return okResult("", "missing path", 1);
    });
    cli.queueExec(ok("cleaned"));
    cli.queueExec(ok("after"));
    cli.queueExecSync(ok("removed-sandbox"));
    cli.queueExecSync(ok("removed-volume"));
    const provider = await createMicrosandboxSandboxProvider("wrk", "sesn", {
      cli,
      now: () => 1_779_999_000_000,
      random: () => 0.123456789,
    });

    await expect(provider.operations.glob.glob({
      pattern: "*.md",
      cwd: "/workspace/missing",
      signal: new AbortController().signal,
      maxMatches: 100,
      maxRawBytes: 1024,
      maxOutputBytes: 1024,
      timeoutMs: 10_000,
    })).rejects.toThrow("missing path");
    expect(provider.isPoisoned?.()).toBe(false);
    await expect(provider.operations.read.readFile("/workspace/a.md"))
      .resolves.toEqual(Buffer.from("after"));
    provider.dispose();
  });

  it("normalizes bash streaming results without forwarding guest env", async () => {
    const cli = new RecordingMicrosandboxCli();
    cli.queueExec(ok("volume"));
    cli.queueExec(ok("sandbox"));
    cli.queueExec((opts) => {
      const token = cli.calls.at(-1)?.args.at(-1);
      opts?.onData?.(Buffer.from(`__OMA_DISPATCHED__:${token}\nstreamed`));
      opts?.onData?.(Buffer.from(`__OMA_TERMINAL__:${token}:exit:7\n`));
      return okResult("", "", 7);
    });
    cli.queueExecSync(ok(""));
    cli.queueExecSync(ok(""));
    const provider = await createMicrosandboxSandboxProvider("wrk", "sesn", {
      cli,
      now: () => 1_779_999_000_000,
      random: () => 0.123456789,
    });
    const chunks: Buffer[] = [];

    await expect(
      provider.operations.bash.exec("exit 7", "/workspace", {
        env: { SHOULD_NOT_ENTER_GUEST: "secret" },
        onData: (chunk) => chunks.push(chunk),
        timeout: 1,
      }),
    ).resolves.toEqual({ exitCode: 7 });
    expect(Buffer.concat(chunks).toString("utf8")).toBe("streamed");
    expect(cli.calls[2]?.args).toContain("--stream");
    expect(cli.calls[2]?.args).not.toContain("--timeout");
    expect(cli.calls[2]?.opts?.env).toBeUndefined();
    provider.dispose();
  });

  it("normalizes guest timeout without disposing the provider", async () => {
    const cli = new RecordingMicrosandboxCli();
    cli.queueExec(ok("volume"));
    cli.queueExec(ok("sandbox"));
    cli.queueExec((opts) => {
      const token = cli.calls.at(-1)?.args.at(-1);
      opts?.onData?.(Buffer.from(`__OMA_DISPATCHED__:${token}\npartial`));
      opts?.onData?.(Buffer.from(`__OMA_TERMINAL__:${token}:timeout:137\n`));
      return okResult("", "", 137);
    });
    cli.queueExec(ok("after"));
    cli.queueExecSync(ok(""));
    cli.queueExecSync(ok(""));
    const provider = await createMicrosandboxSandboxProvider("wrk", "sesn", {
      cli,
      now: () => 1_779_999_000_000,
      random: () => 0.123456789,
    });
    await expect(
      provider.operations.bash.exec("sleep 5", "/workspace", {
        env: {},
        onData: () => {},
        timeout: 1,
      }),
    ).rejects.toThrow("timeout:1");
    await expect(
      provider.operations.read.readFile("/workspace/README.md"),
    ).resolves.toEqual(Buffer.from("after"));
    provider.dispose();
  });

  it("kills guest process groups on host-backstop timeout and maxBuffer loss", async () => {
    const cli = new RecordingMicrosandboxCli();
    cli.queueExec(ok("volume"));
    cli.queueExec(ok("sandbox"));
    cli.queueExec(() => okResult("partial", "", null, "SIGKILL"));
    cli.queueExec(fail("Microsandbox command output exceeded 3 bytes"));
    cli.queueExecSync(ok(""));
    cli.queueExecSync(ok(""));
    cli.queueExecSync(ok(""));
    cli.queueExecSync(ok(""));
    const provider = await createMicrosandboxSandboxProvider("wrk", "sesn", {
      cli,
      now: () => 1_779_999_000_000,
      random: () => 0.123456789,
    });
    await expect(
      provider.operations.bash.exec("sleep 5", "/workspace", {
        env: {},
        onData: () => {},
        timeout: 1,
      }),
    ).rejects.toThrow("timeout:1");
    await expect(
      provider.operations.bash.exec("printf too-much", "/workspace", {
        env: {},
        onData: () => {},
      }),
    ).rejects.toThrow("Microsandbox command output exceeded");
    provider.dispose();
    expect(
      cli.calls.filter(
        (call) =>
          call.mode === "sync" &&
          call.args[0] === "exec" &&
          call.args.join(" ").includes("kill -KILL"),
      ),
    ).toHaveLength(2);
  });

  it("normalizes abort by killing the guest process group", async () => {
    const cli = new RecordingMicrosandboxCli();
    cli.queueExec(ok("volume"));
    cli.queueExec(ok("sandbox"));
    cli.queueExec(failAbort());
    cli.queueExec(ok("after"));
    cli.queueExecSync(ok(""));
    cli.queueExecSync(ok(""));
    cli.queueExecSync(ok(""));
    const provider = await createMicrosandboxSandboxProvider("wrk", "sesn", {
      cli,
      now: () => 1_779_999_000_000,
      random: () => 0.123456789,
    });
    await expect(
      provider.operations.bash.exec("sleep 5", "/workspace", {
        env: {},
        onData: () => {},
      }),
    ).rejects.toThrow("aborted");
    await expect(
      provider.operations.read.readFile("/workspace/README.md"),
    ).resolves.toEqual(Buffer.from("after"));
    expect(cli.calls.some((call) => call.args.join(" ").includes("kill -KILL"))).toBe(
      true,
    );
    provider.dispose();
  });

  it("materializes file mounts under uploads and collects output files", async () => {
    const cli = new RecordingMicrosandboxCli();
    cli.queueExec(ok("volume"));
    cli.queueExec(ok("sandbox"));
    cli.queueExec(ok(""));
    cli.queueExec(ok(""));
    cli.queueExec(ok(""));
    cli.queueExec(
      ok(
        "report.txt\0" +
          "5\0" +
          "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824\0",
      ),
    );
    cli.queueExec(ok("hello"));
    cli.queueExecSync(ok(""));
    cli.queueExecSync(ok(""));
    const provider = await createMicrosandboxSandboxProvider("wrk", "sesn", {
      cli,
      now: () => 1_779_999_000_000,
      random: () => 0.123456789,
    });

    await expect(
      provider.materializeFileResources?.([
        {
          kind: "upload",
          mountPath: "/mnt/session/uploads/data/probe.txt",
          snapshotFileId: "file_snapshot",
          sha256:
            "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
          sizeBytes: 6,
          bytes: Buffer.from("hello\n"),
        },
      ]),
    ).resolves.toBeUndefined();

    const files = await provider.collectOutputFiles?.();
    expect(files?.[0]).toMatchObject({
      relativePath: "report.txt",
      filename: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      sha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
    expect(files?.[0]).toBeDefined();
    expect(await bytesToBuffer(files![0]!.bytes)).toEqual(Buffer.from("hello"));
    provider.dispose();
  });

  it("rejects file mount integrity mismatches before copying into the guest", async () => {
    const cli = new RecordingMicrosandboxCli();
    cli.queueExec(ok("volume"));
    cli.queueExec(ok("sandbox"));
    cli.queueExecSync(ok(""));
    cli.queueExecSync(ok(""));
    const provider = await createMicrosandboxSandboxProvider("wrk", "sesn", {
      cli,
      now: () => 1_779_999_000_000,
      random: () => 0.123456789,
    });

    await expect(
      provider.materializeFileResources?.([
        {
          kind: "upload",
          mountPath: "/mnt/session/uploads/data/probe.txt",
          snapshotFileId: "file_snapshot",
          sha256: "0".repeat(64),
          sizeBytes: 6,
          bytes: Buffer.from("hello\n"),
        },
      ]),
    ).rejects.toThrow("failed integrity validation");
    expect(cli.calls.filter((call) => call.args[0] === "copy")).toHaveLength(0);
    provider.dispose();
  });

  it("rejects output quota failures and unsafe output listing paths", async () => {
    const quotaCli = new RecordingMicrosandboxCli();
    quotaCli.queueExec(ok("volume"));
    quotaCli.queueExec(ok("sandbox"));
    quotaCli.queueExec(() =>
      okResult("", "session output file count exceeds 1\n", 42),
    );
    quotaCli.queueExecSync(ok(""));
    quotaCli.queueExecSync(ok(""));
    const quotaProvider = await createMicrosandboxSandboxProvider("wrk", "sesn", {
      cli: quotaCli,
      now: () => 1_779_999_000_000,
      random: () => 0.123456789,
    });
    await expect(quotaProvider.collectOutputFiles?.()).rejects.toThrow(
      "session output file count exceeds",
    );
    quotaProvider.dispose();

    const pathCli = new RecordingMicrosandboxCli();
    pathCli.queueExec(ok("volume"));
    pathCli.queueExec(ok("sandbox"));
    pathCli.queueExec(ok("../escape.txt\0" + "5\0" + "a".repeat(64) + "\0"));
    pathCli.queueExecSync(ok(""));
    pathCli.queueExecSync(ok(""));
    const pathProvider = await createMicrosandboxSandboxProvider("wrk", "sesn", {
      cli: pathCli,
      now: () => 1_779_999_000_000,
      random: () => 0.123456789,
    });
    await expect(pathProvider.collectOutputFiles?.()).rejects.toThrow(
      "Unsafe session output path",
    );
    pathProvider.dispose();
  });
});

describe("microsandbox sandbox provider factory", () => {
  it("reaps expired OMA sandboxes and orphan workspace volumes", async () => {
    const cli = new RecordingMicrosandboxCli();
    cli.queueExec(ok('[{"name":"old-sandbox"},{"name":"young-sandbox"}]'));
    cli.queueExec(
      ok(
        '{"created_at":"2026-05-28T10:00:00.000Z","mounts":["oma-expired-workspace-volume-old:/workspace"]}',
      ),
    );
    cli.queueExec(
      ok(
        '{"created_at":"2026-05-28T10:59:00.000Z","mounts":["oma-live-workspace-volume-old:/workspace"]}',
      ),
    );
    cli.queueExec(ok(""));
    cli.queueExec(
      ok(
        '["oma-expired-workspace-volume-old","oma-live-workspace-volume-old","oma-orphan-workspace-volume-old","not-oma-workspace-volume-old"]',
      ),
    );
    cli.queueExec(ok('{"Created":"2026-05-28T09:00:00.000Z"}'));
    cli.queueExec(ok('{"Created":"2026-05-28T09:00:00.000Z"}'));
    cli.queueExec(ok(""));
    cli.queueExec(ok(""));

    await expect(
      reapMicrosandboxSandboxes({
        cli,
        olderThanMs: 30 * 60 * 1000,
        now: () => new Date("2026-05-28T11:00:00.000Z").getTime(),
      }),
    ).resolves.toBe(3);

    expect(cli.calls.map((call) => call.args.join(" "))).toEqual([
      "list --format json --label open-managed-agents.sandbox=microsandbox-local --label open-managed-agents.owner=open-managed-agents",
      "inspect old-sandbox --format json",
      "inspect young-sandbox --format json",
      "remove --force old-sandbox",
      "volume list --format json",
      "volume inspect oma-expired-workspace-volume-old",
      "volume inspect oma-orphan-workspace-volume-old",
      "volume remove oma-expired-workspace-volume-old",
      "volume remove oma-orphan-workspace-volume-old",
    ]);
  });

  it("shares the one-time stale sandbox sweep across concurrent first sessions", async () => {
    const cli = new RecordingMicrosandboxCli();
    cli.queueExec(ok("[]"));
    cli.queueExec(ok("[]"));
    cli.queueExec(ok("volume-a"));
    cli.queueExec(ok("sandbox-a"));
    cli.queueExec(ok("volume-b"));
    cli.queueExec(ok("sandbox-b"));
    cli.queueExecSync(ok(""));
    cli.queueExecSync(ok(""));
    cli.queueExecSync(ok(""));
    cli.queueExecSync(ok(""));
    const factory = createMicrosandboxSandboxProviderFactory({
      cli,
      reapStaleSandboxesOlderThanMs: 1,
      now: () => 1_779_999_000_000,
      random: () => 0.123456789,
    });

    const providers = await Promise.all([
      factory("wrk", "sesn_a"),
      factory("wrk", "sesn_b"),
    ]);
    providers.forEach((provider) => provider.dispose());

    expect(
      cli.calls.filter((call) => call.args[0] === "list"),
    ).toHaveLength(1);
    expect(
      cli.calls.filter((call) => call.args[0] === "create"),
    ).toHaveLength(2);
  });
});

const microsandboxLiveIt =
  process.env.OMA_MICROSANDBOX_LIVE === "1" ? it : it.skip;

describe("microsandbox sandbox provider live smoke", () => {
  microsandboxLiveIt(
    "runs tools with no-net, file mounts, outputs, timeout cleanup, and dispose",
    async () => {
      const prefix = `oma-live-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const previousHostSecret = process.env.OMA_LIVE_SECRET_HOST;
      process.env.OMA_LIVE_SECRET_HOST = "should-not-enter-guest";
      let provider: SandboxProvider | undefined;
      try {
        provider = await createMicrosandboxSandboxProvider(
          "wrk_live",
          "sesn_live",
          {
            resourceNamePrefix: prefix,
            operationTimeoutMs: 15_000,
            maxDuration: "10m",
          },
        );

        await provider.operations.write.writeFile(
          "/workspace/README.md",
          "hello\n",
        );
        await expect(
          provider.operations.read.readFile("/workspace/README.md"),
        ).resolves.toEqual(Buffer.from("hello\n"));

        await expect(
          provider.materializeFileResources?.([
            {
              kind: "upload",
              mountPath: "/mnt/session/uploads/data/probe.txt",
              snapshotFileId: "file_snapshot",
              sha256:
                "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
              sizeBytes: 6,
              bytes: Buffer.from("hello\n"),
            },
          ]),
        ).resolves.toBeUndefined();
        await expect(
          provider.operations.read.readFile(
            "/workspace/../mnt/session/uploads/data/probe.txt",
          ),
        ).rejects.toThrow("escapes workspace");
        await expect(provider.operations.grep.grep({
          pattern: "hello",
          cwd: "/mnt/session/uploads",
          glob: "*.txt",
          context: 0,
          headLimit: 100,
          signal: new AbortController().signal,
          maxRawBytes: 1024 * 1024,
          maxOutputBytes: 64 * 1024,
          timeoutMs: 10_000,
        })).resolves.toEqual(["/mnt/session/uploads/data/probe.txt"]);

        await expect(
          provider.operations.bash.exec(
            "wget -T 2 -qO- http://example.com",
            "/workspace",
            { env: {}, onData: () => {}, timeout: 5 },
          ),
        ).resolves.not.toEqual({ exitCode: 0 });

        const secretChunks: Buffer[] = [];
        await expect(
          provider.operations.bash.exec(
            'printf "%s:%s" "${OMA_LIVE_SECRET_HOST:-absent}" "${OMA_LIVE_SECRET_REQUEST:-absent}"',
            "/workspace",
            {
              env: { OMA_LIVE_SECRET_REQUEST: "should-not-enter-guest" },
              onData: (chunk) => secretChunks.push(chunk),
              timeout: 5,
            },
          ),
        ).resolves.toEqual({ exitCode: 0 });
        expect(Buffer.concat(secretChunks).toString("utf8")).toBe(
          "absent:absent",
        );

        await expect(
          provider.operations.bash.exec(
            "nohup sh -c 'while true; do printf x >> /workspace/leak.txt; sleep 0.1; done' >/dev/null 2>&1 & sleep 5",
            "/workspace",
            { env: {}, onData: () => {}, timeout: 0.5 },
          ),
        ).rejects.toThrow("timeout:0.5");
        const sizeAfterTimeout = await readLiveFileSize(provider, "leak.txt");
        await delay(500);
        await expect(readLiveFileSize(provider, "leak.txt")).resolves.toBe(
          sizeAfterTimeout,
        );

        await expect(provider.operations.glob.glob({
          pattern: "*.pid",
          cwd: "/workspace",
          signal: new AbortController().signal,
          maxMatches: 100,
          maxRawBytes: 1024 * 1024,
          maxOutputBytes: 64 * 1024,
          timeoutMs: 10_000,
        })).resolves.toEqual([]);
        await provider.operations.bash.exec(
          "i=1; while [ $i -le 500 ]; do printf x > file-$(printf '%04d' $i).md; i=$((i+1)); done",
          "/workspace",
          { env: {}, onData: () => {}, timeout: 5 },
        );
        await expect(provider.operations.glob.glob({
          pattern: "*.md",
          cwd: "/workspace",
          signal: new AbortController().signal,
          maxMatches: 100,
          maxRawBytes: 1024 * 1024,
          maxOutputBytes: 64 * 1024,
          timeoutMs: 10_000,
        })).resolves.toHaveLength(100);
        const globProcesses: Buffer[] = [];
        await provider.operations.bash.exec(
          "a='.oma-'; b='glob-'; needle=$a$b; for f in /proc/[0-9]*/cmdline; do cmd=$(tr '\\0' ' ' < \"$f\" 2>/dev/null || true); case \"$cmd\" in find\\ \\.\\ -type\\ f\\ -print0*|*\"$needle\"*) printf '%s\\n' \"$cmd\";; esac; done",
          "/workspace",
          { env: {}, onData: (chunk) => globProcesses.push(chunk), timeout: 5 },
        );
        expect(Buffer.concat(globProcesses).toString("utf8")).toBe("");

        await expect(
          provider.operations.bash.exec(
            "printf report > /mnt/session/outputs/report.txt",
            "/workspace",
            { env: {}, onData: () => {}, timeout: 5 },
          ),
        ).resolves.toEqual({ exitCode: 0 });
        const outputs = await provider.collectOutputFiles?.();
        expect(outputs?.map((file) => file.relativePath)).toEqual([
          "report.txt",
        ]);
      } finally {
        if (previousHostSecret === undefined) {
          delete process.env.OMA_LIVE_SECRET_HOST;
        } else {
          process.env.OMA_LIVE_SECRET_HOST = previousHostSecret;
        }
        provider?.dispose();
      }
    },
    120_000,
  );
});

interface RecordedMicrosandboxCall {
  mode: "async" | "sync";
  args: readonly string[];
  opts?: MicrosandboxCliExecOptions;
}

class RecordingMicrosandboxCli implements MicrosandboxCli {
  readonly calls: RecordedMicrosandboxCall[] = [];
  private readonly execQueue: ((
    opts: MicrosandboxCliExecOptions | undefined,
  ) => MicrosandboxCliResult)[] = [];
  private readonly syncQueue: ((
    opts: Omit<MicrosandboxCliExecOptions, "signal"> | undefined,
  ) => MicrosandboxCliResult)[] = [];

  queueExec(
    action: (opts: MicrosandboxCliExecOptions | undefined) => MicrosandboxCliResult,
  ): void {
    this.execQueue.push(action);
  }

  queueExecSync(
    action: (
      opts: Omit<MicrosandboxCliExecOptions, "signal"> | undefined,
    ) => MicrosandboxCliResult,
  ): void {
    this.syncQueue.push(action);
  }

  async exec(
    args: readonly string[],
    opts?: MicrosandboxCliExecOptions,
  ): Promise<MicrosandboxCliResult> {
    if (args.some((arg) => arg.includes(".oma-grep-preflight-"))) {
      return okResult("");
    }
    this.calls.push({ mode: "async", args: [...args], opts });
    const action = this.execQueue.shift() ?? ok("");
    return action(opts);
  }

  execSync(
    args: readonly string[],
    opts?: Omit<MicrosandboxCliExecOptions, "signal">,
  ): MicrosandboxCliResult {
    this.calls.push({ mode: "sync", args: [...args], opts });
    const action = this.syncQueue.shift() ?? ok("");
    return action(opts);
  }
}

function ok(
  stdout: string,
): (opts: MicrosandboxCliExecOptions | undefined) => MicrosandboxCliResult {
  return () => okResult(stdout);
}

function okResult(
  stdout: string,
  stderr = "",
  status: number | null = 0,
  signal: NodeJS.Signals | null = null,
): MicrosandboxCliResult {
  return {
    status,
    signal,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

function fail(
  message: string,
): (opts: MicrosandboxCliExecOptions | undefined) => MicrosandboxCliResult {
  return () => {
    throw new Error(message);
  };
}

function failAbort(): (
  opts: MicrosandboxCliExecOptions | undefined,
) => MicrosandboxCliResult {
  return () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  };
}

async function bytesToBuffer(
  bytes: AsyncIterable<Uint8Array> | Uint8Array,
): Promise<Buffer> {
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  const chunks: Uint8Array[] = [];
  for await (const chunk of bytes) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readLiveFileSize(
  provider: SandboxProvider,
  relativePath: string,
): Promise<number> {
  if (!/^[A-Za-z0-9._/-]+$/.test(relativePath)) {
    throw new Error(`unsafe live smoke path: ${relativePath}`);
  }
  const absolutePath = `/workspace/${relativePath}`;
  const chunks: Buffer[] = [];
  await provider.operations.bash.exec(
    `test ! -e '${absolutePath}' && printf 0 || wc -c < '${absolutePath}'`,
    "/workspace",
    {
      env: {},
      onData: (chunk) => chunks.push(chunk),
      timeout: 5,
    },
  );
  return Number(Buffer.concat(chunks).toString("utf8").trim());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
