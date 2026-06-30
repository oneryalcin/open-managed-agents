import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MICROSANDBOX_IMAGE,
  DEFAULT_MICROSANDBOX_OUTPUTS_PATH,
  DEFAULT_MICROSANDBOX_UPLOADS_PATH,
  DEFAULT_MICROSANDBOX_WORKSPACE,
  NodeMicrosandboxCli,
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
  execMicrosandboxCommand,
  microsandboxCliEnv,
  microsandboxPathRef,
  microsandboxResourceName,
  type MicrosandboxCli,
  type MicrosandboxCliExecOptions,
  type MicrosandboxCliResult,
} from "../microsandbox.ts";

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
});

describe("microsandbox CLI adapter", () => {
  it("prepends the current Node directory so msb's env-node wrapper works", async () => {
    const nodeDir = dirname(process.execPath);
    const env = microsandboxCliEnv(
      { PATH: "/usr/bin:/bin" },
      { nodeExecutable: process.execPath },
    );

    expect(env.PATH?.split(":").at(0)).toBe(nodeDir);

    const cli = new NodeMicrosandboxCli({
      command: "/usr/bin/env",
      env: { PATH: "/usr/bin:/bin" },
      nodeExecutable: process.execPath,
    });
    const result = await cli.exec(["node", "--version"], {
      env: { PATH: "/usr/bin:/bin" },
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

  it("can kill a hung child process at the adapter boundary", async () => {
    const result = await execMicrosandboxCommand(
      "/bin/sh",
      ["-c", "sleep 10"],
      { timeoutMs: 10 },
    );

    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGKILL");
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
      `create ${DEFAULT_MICROSANDBOX_IMAGE} --name oma-sbx --mount-named oma-vol:/workspace --workdir /workspace --no-net --pull if-missing --quiet`,
      "volume remove oma-vol",
    ]);
    expect(cli.calls.map((call) => call.mode)).toEqual([
      "async",
      "async",
      "sync",
    ]);
  });
});

interface RecordedMicrosandboxCall {
  mode: "async" | "sync";
  args: readonly string[];
  opts?: MicrosandboxCliExecOptions;
}

class RecordingMicrosandboxCli implements MicrosandboxCli {
  readonly calls: RecordedMicrosandboxCall[] = [];
  private readonly execQueue: (() => MicrosandboxCliResult)[] = [];
  private readonly syncQueue: (() => MicrosandboxCliResult)[] = [];

  queueExec(action: () => MicrosandboxCliResult): void {
    this.execQueue.push(action);
  }

  queueExecSync(action: () => MicrosandboxCliResult): void {
    this.syncQueue.push(action);
  }

  async exec(
    args: readonly string[],
    opts?: MicrosandboxCliExecOptions,
  ): Promise<MicrosandboxCliResult> {
    this.calls.push({ mode: "async", args: [...args], opts });
    const action = this.execQueue.shift() ?? ok("");
    return action();
  }

  execSync(
    args: readonly string[],
    opts?: Omit<MicrosandboxCliExecOptions, "signal">,
  ): MicrosandboxCliResult {
    this.calls.push({ mode: "sync", args: [...args], opts });
    const action = this.syncQueue.shift() ?? ok("");
    return action();
  }
}

function ok(stdout: string): () => MicrosandboxCliResult {
  return () => ({
    status: 0,
    signal: null,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
  });
}

function fail(message: string): () => MicrosandboxCliResult {
  return () => {
    throw new Error(message);
  };
}
