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
import {
  createEgressSidecar,
  egressProxyUrl,
} from "../docker-egress.ts";
import { resolveSessionEgressBundle } from "../../../../egress/policy.ts";
import { DatabaseSync } from "node:sqlite";
import { createSessionEgressBundleResolver } from "../../../../app.ts";
import { SqliteEnvironmentStore } from "../../../../environments/store.ts";
import {
  generateMasterKey,
  parseMasterKey,
} from "../../../../secrets/master-key.ts";
import { SqliteSecretsStore } from "../../../../secrets/store.ts";
import { SqliteSessionStore } from "../../../store.ts";
import type { JsonObject } from "../../../../../types/json.ts";

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

  it("swaps --network none for the sidecar net and wires CA + proxy + sentinels under egress (0117d)", () => {
    const args = buildDockerRunArgs({
      containerName: "oma-test",
      workspacePath: "/workspace",
      image: "alpine:3.19",
      memory: "256m",
      cpus: "1",
      pidsLimit: "64",
      tmpfsSize: "64m",
      egress: {
        networkName: "oma-egress-sess-abc",
        caCertDirHostPath: "/host/oma-egress/shared",
        proxyUrl: "http://srt:tok@oma-egress-proxy-sess:8080",
        sandboxEnv: { GITHUB_TOKEN: "oma-sentinel-deadbeef" },
      },
    });
    // Joins the sidecar's --internal net instead of being fully isolated.
    expect(args).toContain("oma-egress-sess-abc");
    expect(args).not.toContain("none");
    // CA mounted read-only; trust + proxy env point the sandbox at the sidecar.
    expect(args).toContain("/host/oma-egress/shared:/etc/oma:ro");
    expect(args).toContain("SSL_CERT_FILE=/etc/oma/ca.crt");
    expect(args).toContain("NODE_EXTRA_CA_CERTS=/etc/oma/ca.crt");
    expect(args).toContain("HTTPS_PROXY=http://srt:tok@oma-egress-proxy-sess:8080");
    expect(args).toContain("https_proxy=http://srt:tok@oma-egress-proxy-sess:8080");
    // The per-session sentinel reaches the agent's environment.
    expect(args).toContain("GITHUB_TOKEN=oma-sentinel-deadbeef");
  });

  it("keeps --network none and injects no proxy env when egress is absent (default deny)", () => {
    const args = buildDockerRunArgs({
      containerName: "oma-test",
      workspacePath: "/workspace",
      image: "alpine:3.19",
      memory: "256m",
      cpus: "1",
      pidsLimit: "64",
      tmpfsSize: "64m",
    });
    expect(args).toContain("--network");
    expect(args).toContain("none");
    expect(args.join(" ")).not.toContain("HTTPS_PROXY");
    expect(args.join(" ")).not.toContain("/etc/oma");
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
    if [[ "$*" == *egress-sidecar* ]]; then
      : # egress-sidecar sweep: no orphans
    else
      printf 'stale-container\\n'
    fi
    ;;
  network)
    : # egress-sidecar network sweep: no orphans
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
      // The container sweep (sandbox label) runs exactly once despite two
      // concurrent first sessions; the egress sweep rides the same barrier.
      expect(
        calls.filter(
          (call) =>
            call.startsWith("ps ") &&
            call.includes("open-managed-agents.sandbox"),
        ),
      ).toHaveLength(1);
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
    if [[ "$*" == *egress-sidecar* ]]; then
      : # egress-sidecar sweep: no orphans
    elif [[ ! -f "${statePath}" ]]; then
      : > "${statePath}"
      printf 'transient docker failure\\n' >&2
      exit 1
    fi
    ;;
  network)
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
      // The container sweep (sandbox label) fails once, then retries: two ps.
      expect(
        calls.filter(
          (call) =>
            call.startsWith("ps ") &&
            call.includes("open-managed-agents.sandbox"),
        ),
      ).toHaveLength(2);
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

describe("Docker sandbox egress cleanup on failure (plan 0117d)", () => {
  it("disposes the egress sidecar when sandbox container creation fails", async () => {
    let disposed = false;
    await expect(
      createDockerSandboxProvider("wrk_x", "sesn_x", {
        // A docker command that cannot be spawned makes the sandbox `docker
        // run` fail AFTER the (fake) sidecar was already created.
        dockerCommand: "/nonexistent-docker-binary-oma-test",
        operationTimeoutMs: 5_000,
        egress: {
          wiring: {
            networkName: "oma-egress-x",
            caCertDirHostPath: "/tmp/x",
            proxyUrl: "http://srt:t@oma-egress-proxy-x:8080",
            sandboxEnv: {},
          },
          dispose: () => {
            disposed = true;
          },
        },
      }),
    ).rejects.toThrow();
    // Without the cleanup path this leaks the sidecar container + its resolved
    // secret bundle on disk.
    expect(disposed).toBe(true);
  });

  // Factory-level double-dispose (Sonnet review): a real sidecar comes up, then
  // the SANDBOX `docker run` fails (bad image) — createDockerSandboxProvider's
  // own catch AND the factory closure's catch both call dispose(). Proves the
  // overlap is harmless (idempotent) and no --internal network is orphaned.
  dockerIt("factory disposes the sidecar exactly once-effectively when the sandbox image is bad", async () => {
    const bundle = resolveSessionEgressBundle({
      environmentConfig: { networking: { allow: [{ host: "example.com", port: 443 }] } },
      revealSecret: () => undefined,
      listenPort: 8080,
      proxyAuthToken: "factory-dispose-tok",
    })!.bundle;
    const sessionId = `sesn_factdispose_${Math.random().toString(36).slice(2, 8)}`;
    const factory = createDockerSandboxProviderFactory({
      image: "oma-nonexistent-image:doesnotexist-0117e",
      operationTimeoutMs: 30_000,
      egress: {
        sidecarImage: "node:24-slim",
        sidecarRepoMount: process.cwd(),
        resolveEgressBundle: async () => ({ bundle, sandboxEnv: {} }),
      },
    });
    await expect(factory("wrk_fd", sessionId)).rejects.toThrow();

    // The sidecar's --internal network is named oma-egress-<sanitized session>-*
    const networks = spawnSync("docker", ["network", "ls", "--format", "{{.Name}}"], {
      encoding: "utf8",
    }).stdout;
    expect(networks).not.toContain(`oma-egress-${sessionId}`);
  }, 120_000);
});

describe("Docker sandbox egress confinement (plan 0117d, ADR 0016 §2/§3)", () => {
  // The ADR-owed test: a proxy-only-egress sandbox reaches the internet ONLY
  // through the sidecar proxy, which enforces auth + allowlist; a raw socket
  // to anything else is dropped by the --internal network. Runs the sidecar
  // from node:24-slim with the repo bind-mounted (no built appliance image in
  // CI). Enforcement is asserted at the plaintext CONNECT layer, so no real
  // upstream is needed and the test is hermetic.
  dockerIt("routes egress only through the auth'd, allowlisting proxy — raw sockets cannot escape", async () => {
    const resolved = resolveSessionEgressBundle({
      environmentConfig: {
        networking: {
          allow: [{ host: "example.com", port: 443 }],
        },
      },
      revealSecret: () => undefined,
      listenPort: 8080,
      proxyAuthToken: "confine-tok-123",
    })!;

    const sidecar = await createEgressSidecar({
      dockerCommand: "docker",
      sessionId: `sesn_confine_${Math.random().toString(36).slice(2, 8)}`,
      bundle: resolved.bundle,
      sidecarImage: "node:24-slim",
      sidecarRepoMount: process.cwd(),
      operationTimeoutMs: 30_000,
      readinessTimeoutMs: 40_000,
    });

    const provider = await createDockerSandboxProvider("wrk_confine", "sesn_confine", {
      operationTimeoutMs: 20_000,
      egress: {
        wiring: {
          networkName: sidecar.networkName,
          caCertDirHostPath: sidecar.sharedDirHostPath,
          proxyUrl: egressProxyUrl(sidecar),
          sandboxEnv: resolved.sandboxEnv,
        },
        dispose: sidecar.dispose,
      },
    });

    const run = async (command: string): Promise<string> => {
      const chunks: Buffer[] = [];
      await provider.operations.bash.exec(command, "/workspace", {
        env: {},
        onData: (c) => chunks.push(c),
        timeout: 15,
      });
      return Buffer.concat(chunks).toString("utf8");
    };

    try {
      // The boundary wiring reached the sandbox: proxy env + trusted CA file.
      expect(await run('printf "%s" "$HTTPS_PROXY"')).toContain(
        `@${sidecar.proxyHost}:${sidecar.proxyPort}`,
      );
      expect(await run("cat /etc/oma/ca.crt | head -1")).toContain(
        "BEGIN CERTIFICATE",
      );

      // A plaintext CONNECT to the proxy: no auth -> 407, so the proxy is live
      // AND fails closed on the vendored fail-open default.
      const noAuth = await run(
        'exec 3<>/dev/tcp/' + sidecar.proxyHost + '/' + sidecar.proxyPort +
          ' && printf "CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\n\\r\\n" >&3 && head -1 <&3',
      );
      expect(noAuth).toContain("407");

      // With auth but a NON-allowlisted host -> 403 (allowlist enforced).
      const auth = Buffer.from("srt:confine-tok-123").toString("base64");
      const offAllow = await run(
        'exec 3<>/dev/tcp/' + sidecar.proxyHost + '/' + sidecar.proxyPort +
          ' && printf "CONNECT www.google.com:443 HTTP/1.1\\r\\nProxy-Authorization: Basic ' + auth +
          '\\r\\nHost: www.google.com:443\\r\\n\\r\\n" >&3 && head -1 <&3',
      );
      expect(offAllow).toContain("403");

      // With auth AND an allowlisted host -> 200 Connection Established.
      const allowed = await run(
        'exec 3<>/dev/tcp/' + sidecar.proxyHost + '/' + sidecar.proxyPort +
          ' && printf "CONNECT example.com:443 HTTP/1.1\\r\\nProxy-Authorization: Basic ' + auth +
          '\\r\\nHost: example.com:443\\r\\n\\r\\n" >&3 && head -1 <&3',
      );
      expect(allowed).toContain("200");

      // CONFINEMENT: a raw socket straight to a public IP, bypassing the proxy,
      // cannot escape the --internal network.
      const direct = await run(
        'timeout 6 bash -c "exec 3<>/dev/tcp/1.1.1.1/443 && echo ESCAPED" ; echo "rc=$?"',
      );
      expect(direct).not.toContain("ESCAPED");
      expect(direct).toContain("rc="); // the dial failed/timed out, did not connect
    } finally {
      provider.dispose(); // also disposes the sidecar + its --internal network
    }
  });
});

describe("Wired egress session path (plan 0117e-4)", () => {
  // The full production wiring in real Docker: stores -> the app.ts bundle
  // resolver -> the docker FACTORY closure (not a hand-built sidecar) ->
  // sidecar + sandbox. Proves the granted session gets a sentinel (never the
  // secret), trust + proxy wiring, and live CONNECT-layer enforcement with
  // the per-session token — while a sibling session with no networking stays
  // at --network none through the same factory (wired default-deny). The
  // "upstream saw the REAL token" half of 0117e-4 lives in
  // egress-session-wiring.test.ts (in-process twin — the sidecar's SSRF deny
  // has no private-IP test override by design, so no local upstream here).
  dockerIt("factory-wired sandbox enforces egress; no-networking sibling stays dark", async () => {
    const db = new DatabaseSync(":memory:");
    const sessions = new SqliteSessionStore(db);
    const environments = new SqliteEnvironmentStore(db);
    const secrets = new SqliteSecretsStore(
      db,
      parseMasterKey(generateMasterKey(), "test"),
    );
    secrets.put("wrk_default", "github", "REAL-TOKEN-0117e");
    const now = new Date().toISOString();
    const seed = (envId: string, sessionId: string, config: JsonObject) => {
      environments.create({
        row: {
          id: envId, workspace_id: "wrk_default", type: "environment",
          name: envId, config, created_at: now, updated_at: now,
          archived_at: null,
        },
      });
      sessions.create({
        row: {
          id: sessionId, workspace_id: "wrk_default", type: "session",
          agent: { type: "agent", id: "agent_seed", version: 1 },
          environment_id: envId, status: "idle", title: null, metadata: {},
          created_at: now, updated_at: now, archived_at: null, usage: null,
          resources: [],
        },
      });
    };
    const suffix = Math.random().toString(36).slice(2, 8);
    seed(`env_wired_${suffix}`, `sesn_wired_${suffix}`, {
      networking: {
        allow: [{ host: "example.com", port: 443 }],
        credentials: [
          {
            secret: "github", env: "GITHUB_TOKEN", host: "example.com",
            port: 443, pathPrefix: "/", header: "authorization",
          },
        ],
      },
    });
    seed(`env_dark_${suffix}`, `sesn_dark_${suffix}`, { type: "cloud" });

    const factory = createDockerSandboxProviderFactory({
      operationTimeoutMs: 20_000,
      egress: {
        sidecarImage: "node:24-slim",
        sidecarRepoMount: process.cwd(),
        resolveEgressBundle: createSessionEgressBundleResolver({
          sessions, environments, secrets,
        }),
      },
    });
    const run = async (
      provider: Awaited<ReturnType<typeof factory>>,
      command: string,
    ): Promise<string> => {
      const chunks: Buffer[] = [];
      await provider.operations.bash.exec(command, "/workspace", {
        env: {},
        onData: (c) => chunks.push(c),
        timeout: 15,
      });
      return Buffer.concat(chunks).toString("utf8");
    };

    const granted = await factory("wrk_default", `sesn_wired_${suffix}`);
    try {
      // The agent's env holds the per-session sentinel, never the secret.
      const tokenEnv = await run(granted, 'printf "%s" "$GITHUB_TOKEN"');
      expect(tokenEnv).toMatch(/^oma-sentinel-[0-9a-f]{32}$/);
      expect(tokenEnv).not.toContain("REAL-TOKEN");
      // Trust + proxy wiring landed.
      expect(await run(granted, "head -1 /etc/oma/ca.crt")).toContain(
        "BEGIN CERTIFICATE",
      );
      expect(await run(granted, 'printf "%s" "$HTTPS_PROXY"')).toMatch(
        /^http:\/\/srt:[0-9a-f]+@oma-egress-proxy-/,
      );

      // CONNECT-layer enforcement with the per-session token, derived
      // in-sandbox from HTTPS_PROXY exactly as a real client would.
      const connect = (host: string, withAuth: boolean): string =>
        'H="${HTTPS_PROXY#http://}"; CRED="${H%%@*}"; HP="${H#*@}"; ' +
        'PH="${HP%%:*}"; PP="${HP##*:}"; ' +
        'AUTH=$(printf "%s" "$CRED" | base64 | tr -d "\\n"); ' +
        `exec 3<>/dev/tcp/$PH/$PP && printf "CONNECT ${host}:443 HTTP/1.1\\r\\n` +
        (withAuth ? 'Proxy-Authorization: Basic $AUTH\\r\\n' : "") +
        `Host: ${host}:443\\r\\n\\r\\n" >&3 && head -1 <&3`;
      expect(await run(granted, connect("example.com", false))).toContain("407");
      expect(await run(granted, connect("www.google.com", true))).toContain("403");
      expect(await run(granted, connect("example.com", true))).toContain("200");

      // Wired default-deny: the SAME factory leaves a no-networking session
      // at --network none — no proxy env, no CA mount, no sidecar.
      const dark = await factory("wrk_default", `sesn_dark_${suffix}`);
      try {
        expect(await run(dark, 'printf "%s" "$HTTPS_PROXY"')).toBe("");
        expect(await run(dark, 'ls /etc/oma 2>&1; true')).not.toContain("ca.crt");
      } finally {
        dark.dispose();
      }
    } finally {
      granted.dispose(); // tears down the sidecar + --internal network
      db.close();
    }
  }, 120_000);

  // #142: a file-resource session prepares its sandbox BEFORE its row is
  // committed, so the factory is called with the environmentId hint and NO
  // persisted session row. Proves that prepare-time path stands up a real,
  // enforcing sidecar in Docker (the unit tests prove the bundle resolves;
  // this proves it becomes a working confined sandbox).
  dockerIt("factory hint path (pre-commit prepare) stands up an enforcing sidecar", async () => {
    const db = new DatabaseSync(":memory:");
    const sessions = new SqliteSessionStore(db);
    const environments = new SqliteEnvironmentStore(db);
    const secrets = new SqliteSecretsStore(
      db,
      parseMasterKey(generateMasterKey(), "test"),
    );
    secrets.put("wrk_default", "github", "REAL-TOKEN-142");
    const suffix = Math.random().toString(36).slice(2, 8);
    const envId = `env_hint_${suffix}`;
    const now = new Date().toISOString();
    environments.create({
      row: {
        id: envId, workspace_id: "wrk_default", type: "environment",
        name: envId, created_at: now, updated_at: now, archived_at: null,
        config: {
          networking: {
            allow: [{ host: "example.com", port: 443 }],
            credentials: [
              {
                secret: "github", env: "GITHUB_TOKEN", host: "example.com",
                port: 443, pathPrefix: "/", header: "authorization",
              },
            ],
          },
        },
      },
    });
    // Deliberately NO sessions.create(...) — this is the pre-commit condition.

    const factory = createDockerSandboxProviderFactory({
      operationTimeoutMs: 20_000,
      egress: {
        sidecarImage: "node:24-slim",
        sidecarRepoMount: process.cwd(),
        resolveEgressBundle: createSessionEgressBundleResolver({
          sessions, environments, secrets,
        }),
      },
    });
    const run = async (
      provider: Awaited<ReturnType<typeof factory>>,
      command: string,
    ): Promise<string> => {
      const chunks: Buffer[] = [];
      await provider.operations.bash.exec(command, "/workspace", {
        env: {},
        onData: (c) => chunks.push(c),
        timeout: 15,
      });
      return Buffer.concat(chunks).toString("utf8");
    };

    const sessionId = `sesn_hint_${suffix}`;
    // The hint the runner forwards from prepareSession; the row does not exist.
    const provider = await factory("wrk_default", sessionId, { environmentId: envId });
    try {
      const tokenEnv = await run(provider, 'printf "%s" "$GITHUB_TOKEN"');
      expect(tokenEnv).toMatch(/^oma-sentinel-[0-9a-f]{32}$/);
      expect(tokenEnv).not.toContain("REAL-TOKEN");
      expect(await run(provider, 'printf "%s" "$HTTPS_PROXY"')).toMatch(
        /^http:\/\/srt:[0-9a-f]+@oma-egress-proxy-/,
      );
      const connect = (host: string, withAuth: boolean): string =>
        'H="${HTTPS_PROXY#http://}"; CRED="${H%%@*}"; HP="${H#*@}"; ' +
        'PH="${HP%%:*}"; PP="${HP##*:}"; ' +
        'AUTH=$(printf "%s" "$CRED" | base64 | tr -d "\\n"); ' +
        `exec 3<>/dev/tcp/$PH/$PP && printf "CONNECT ${host}:443 HTTP/1.1\\r\\n` +
        (withAuth ? 'Proxy-Authorization: Basic $AUTH\\r\\n' : "") +
        `Host: ${host}:443\\r\\n\\r\\n" >&3 && head -1 <&3`;
      expect(await run(provider, connect("example.com", false))).toContain("407");
      expect(await run(provider, connect("example.com", true))).toContain("200");
      expect(await run(provider, connect("www.google.com", true))).toContain("403");
    } finally {
      provider.dispose();
      db.close();
    }
  }, 120_000);
});

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
