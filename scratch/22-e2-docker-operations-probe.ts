/**
 * Probe 22 — Cycle E.2.0 Docker Operations delegation.
 *
 * Goal:
 *   Measure the concrete Docker-local shape before implementing a provider.
 *   E.2 intentionally keeps Pi/control-plane on the host and delegates Pi
 *   Operations into Docker. This probe checks the backend realities that shape
 *   the provider: streaming, timeout/abort cleanup, file-operation boundary,
 *   and the minimum isolation bar.
 *
 * Run:
 *   npx tsx scratch/22-e2-docker-operations-probe.ts
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OUT_DIR = join(process.cwd(), "scratch", "artifacts", "docker-sandbox");
const IMAGE = process.env.OMA_DOCKER_PROBE_IMAGE ?? "alpine:3.19";
const containerName = `oma-e2-probe-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

interface CommandResult {
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  stdoutChunks: Array<{ atMs: number; text: string }>;
  stderrChunks: Array<{ atMs: number; text: string }>;
}

interface ProbeSummary {
  generated_at: string;
  image: string;
  container_name: string;
  docker_available: boolean;
  container_started: boolean;
  cleanup_removed_container: boolean;
  isolation_bar: {
    non_root_user: boolean;
    network_none: boolean;
    read_only_rootfs: boolean;
    workspace_tmpfs: boolean;
    no_docker_socket: boolean;
    cap_drop_all: boolean;
    no_new_privileges: boolean;
    pids_limit: number | null;
    memory_limit_bytes: number | null;
  };
  bash_exec: {
    streamed_stdout_chunks: number;
    first_chunk_before_exit: boolean;
    stdout: string;
    exitCode: number | null;
  };
  timeout: {
    command_exitCode: number | null;
    durationMs: number;
    leftover_sleep_processes: string;
  };
  abort: {
    docker_cli_signal: NodeJS.Signals | null;
    leftover_sleep_processes_after_cli_kill: string;
    provider_implication: string;
  };
  file_ops: {
    exec_per_op: {
      write_read_ok: boolean;
      edit_ok: boolean;
      list_ok: boolean;
      find_ok: boolean;
      observed_files: string[];
    };
    bind_mount_assessment: string;
    fs_bridge_assessment: string;
    recommended_e2_1_boundary: string;
  };
  network: {
    wget_exitCode: number | null;
    denied: boolean;
  };
  verdict: "PASS" | "FAIL";
  notes: string[];
}

const notes: string[] = [];
let containerStarted = false;
let cleanupRemovedContainer = false;
let dockerAvailable = false;

try {
  await mkdir(OUT_DIR, { recursive: true });
  await ensureDockerAvailable();
  dockerAvailable = true;
  await ensureImagePresent(IMAGE);
  await startContainer();
  containerStarted = true;

  const inspect = JSON.parse(
    (
      await docker(["inspect", containerName, "--format", "{{json .}}"])
    ).stdout,
  ) as {
    HostConfig?: {
      NetworkMode?: string;
      ReadonlyRootfs?: boolean;
      CapDrop?: string[];
      SecurityOpt?: string[];
      PidsLimit?: number;
      Memory?: number;
      Tmpfs?: Record<string, string>;
      Binds?: string[] | null;
    };
  };

  const id = await dockerExec(["id", "-u"]);
  const socket = await dockerExec(["sh", "-lc", "test -S /var/run/docker.sock"]);
  const streaming = await dockerExec([
    "sh",
    "-lc",
    "printf 'stream:one\\n'; sleep 0.2; printf 'stream:two\\n'",
  ]);
  const timeout = await dockerExec([
    "timeout",
    "-s",
    "KILL",
    "1",
    "sh",
    "-lc",
    "sleep 30 & wait",
  ]);
  const leftoverAfterTimeout = await dockerExec([
    "sh",
    "-lc",
    "pgrep -a sleep || true",
  ]);

  const abort = await rawAbortProbe();
  const leftoverAfterAbort = await dockerExec([
    "sh",
    "-lc",
    "pgrep -a sleep || true",
  ]);
  if (leftoverAfterAbort.stdout.trim() !== "") {
    notes.push(
      "Killing the docker CLI can leave the in-container process alive; provider abort must run explicit in-container cleanup.",
    );
    await dockerExec(["sh", "-lc", "pkill -KILL sleep || true"]);
  }

  const fileOps = await probeExecPerOpFileOperations();
  const network = await dockerExec([
    "sh",
    "-lc",
    "wget -qO- -T 1 http://example.com >/dev/null",
  ]);

  const isolationBar = {
    non_root_user: id.stdout.trim() !== "0",
    network_none: inspect.HostConfig?.NetworkMode === "none",
    read_only_rootfs: inspect.HostConfig?.ReadonlyRootfs === true,
    workspace_tmpfs: Object.keys(inspect.HostConfig?.Tmpfs ?? {}).some(
      (mount) => mount === "/workspace",
    ),
    no_docker_socket: socket.exitCode !== 0,
    cap_drop_all: inspect.HostConfig?.CapDrop?.includes("ALL") === true,
    no_new_privileges:
      inspect.HostConfig?.SecurityOpt?.includes("no-new-privileges") === true,
    pids_limit: inspect.HostConfig?.PidsLimit ?? null,
    memory_limit_bytes: inspect.HostConfig?.Memory ?? null,
  };

  const streamedStdoutChunks = streaming.stdoutChunks.filter(
    (chunk) => chunk.text.length > 0,
  );
  const summary: ProbeSummary = {
    generated_at: new Date().toISOString(),
    image: IMAGE,
    container_name: containerName,
    docker_available: true,
    container_started: containerStarted,
    cleanup_removed_container: false,
    isolation_bar: isolationBar,
    bash_exec: {
      streamed_stdout_chunks: streamedStdoutChunks.length,
      first_chunk_before_exit:
        streamedStdoutChunks.length > 0 &&
        streamedStdoutChunks[0]!.atMs < streaming.durationMs,
      stdout: streaming.stdout,
      exitCode: streaming.exitCode,
    },
    timeout: {
      command_exitCode: timeout.exitCode,
      durationMs: timeout.durationMs,
      leftover_sleep_processes: leftoverAfterTimeout.stdout.trim(),
    },
    abort: {
      docker_cli_signal: abort.signal,
      leftover_sleep_processes_after_cli_kill: leftoverAfterAbort.stdout.trim(),
      provider_implication:
        leftoverAfterAbort.stdout.trim() === ""
          ? "Docker CLI termination cleaned the exec process in this environment; provider should still keep an explicit cleanup path."
          : "Docker CLI termination did not clean the in-container process; provider must kill or recreate the container on abort.",
    },
    file_ops: {
      exec_per_op: fileOps,
      bind_mount_assessment:
        "Rejected for E.2.1 default: it is simpler and faster, but file contents live on the host and file Operations become host-visible again. Keep bind mounts for explicit resource mounting later, not provider internals.",
      fs_bridge_assessment:
        "Best long-term boundary for performance and quoting, but more code. Defer until exec-per-op proves too slow or insufficient.",
      recommended_e2_1_boundary:
        "Use exec-per-op inside the container for the first Docker provider. It keeps bash and file Operations inside Docker, preserves the E.2 isolation claim, and is small enough to test.",
    },
    network: {
      wget_exitCode: network.exitCode,
      denied: network.exitCode !== 0,
    },
    verdict: "FAIL",
    notes,
  };
  summary.verdict = summaryPasses(summary) ? "PASS" : "FAIL";
  cleanupRemovedContainer = await cleanupContainer();
  summary.cleanup_removed_container = cleanupRemovedContainer;
  await writeSummary(summary);
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  const summary = {
    generated_at: new Date().toISOString(),
    image: IMAGE,
    container_name: containerName,
    docker_available: dockerAvailable,
    container_started: containerStarted,
    cleanup_removed_container: false,
    error: error instanceof Error ? error.message : String(error),
    notes,
    verdict: "FAIL",
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    join(OUT_DIR, "_e2-docker-operations-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  if (!cleanupRemovedContainer) {
    cleanupRemovedContainer = await cleanupContainer();
  }
}

async function ensureDockerAvailable(): Promise<void> {
  await docker(["version", "--format", "{{json .}}"]);
}

async function ensureImagePresent(image: string): Promise<void> {
  const inspected = await docker(["image", "inspect", image]);
  if (inspected.exitCode !== 0) {
    throw new Error(
      `Required probe image is not available locally: ${image}. Pull it before rerunning.`,
    );
  }
}

async function startContainer(): Promise<void> {
  await docker([
    "run",
    "-d",
    "--name",
    containerName,
    "--network",
    "none",
    "--cpus",
    "1",
    "--memory",
    "128m",
    "--pids-limit",
    "64",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/workspace:rw,exec,nosuid,nodev,uid=65534,gid=65534,mode=700,size=64m",
    "--workdir",
    "/workspace",
    "--user",
    "65534:65534",
    IMAGE,
    "tail",
    "-f",
    "/dev/null",
  ]);
}

async function dockerExec(command: string[], input?: string): Promise<CommandResult> {
  return docker(["exec", "-i", containerName, ...command], input);
}

async function probeExecPerOpFileOperations(): Promise<ProbeSummary["file_ops"]["exec_per_op"]> {
  const content = "hello docker\n";
  const path = "/workspace/probe.txt";
  await dockerExec(["sh", "-lc", `cat > ${shellQuote(path)}`], content);
  const read = await dockerExec(["cat", path]);
  await dockerExec([
    "sh",
    "-lc",
    `sed -i 's/docker/Docker/' ${shellQuote(path)}`,
  ]);
  const edited = await dockerExec(["cat", path]);
  await dockerExec(["sh", "-lc", "mkdir -p /workspace/sub && touch /workspace/sub/nested.md"]);
  const list = await dockerExec(["ls", "-1", "/workspace"]);
  const found = await dockerExec([
    "find",
    "/workspace",
    "-maxdepth",
    "2",
    "-type",
    "f",
  ]);
  const observedFiles = found.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  return {
    write_read_ok: read.stdout === content,
    edit_ok: edited.stdout === "hello Docker\n",
    list_ok: list.stdout.includes("probe.txt") && list.stdout.includes("sub"),
    find_ok:
      observedFiles.includes("/workspace/probe.txt") &&
      observedFiles.includes("/workspace/sub/nested.md"),
    observed_files: observedFiles,
  };
}

async function rawAbortProbe(): Promise<CommandResult> {
  const child = spawn("docker", [
    "exec",
    containerName,
    "sh",
    "-lc",
    "sleep 30",
  ], {
    detached: true,
  });
  const started = Date.now();
  const stdoutChunks: CommandResult["stdoutChunks"] = [];
  const stderrChunks: CommandResult["stderrChunks"] = [];
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout += text;
    stdoutChunks.push({ atMs: Date.now() - started, text });
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr += text;
    stderrChunks.push({ atMs: Date.now() - started, text });
  });
  await delay(250);
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  const { exitCode, signal, timedOut } = await waitForChildWithTimeout(
    child,
    750,
  );
  if (timedOut && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  return {
    args: ["docker", "exec", containerName, "sh", "-lc", "sleep 30"],
    exitCode,
    signal: timedOut ? "SIGKILL" : signal,
    stdout,
    stderr,
    durationMs: Date.now() - started,
    stdoutChunks,
    stderrChunks,
  };
}

async function docker(args: string[], input?: string): Promise<CommandResult> {
  const started = Date.now();
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  const stdoutChunks: CommandResult["stdoutChunks"] = [];
  const stderrChunks: CommandResult["stderrChunks"] = [];
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout += text;
    stdoutChunks.push({ atMs: Date.now() - started, text });
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr += text;
    stderrChunks.push({ atMs: Date.now() - started, text });
  });
  if (input !== undefined) child.stdin.end(input);
  else child.stdin.end();
  const { exitCode, signal } = await waitForChild(child);
  const result = {
    args,
    exitCode,
    signal,
    stdout,
    stderr,
    durationMs: Date.now() - started,
    stdoutChunks,
    stderrChunks,
  };
  if (exitCode !== 0 && !allowedNonZero(args)) {
    throw new Error(
      `docker ${args.join(" ")} failed with ${exitCode}: ${stderr || stdout}`,
    );
  }
  return result;
}

function waitForChild(
  child: ReturnType<typeof spawn>,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

function waitForChildWithTimeout(
  child: ReturnType<typeof spawn>,
  ms: number,
): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      resolve({
        exitCode: child.exitCode,
        signal: child.signalCode,
        timedOut: true,
      });
    }, ms);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut: false });
    });
  });
}

function allowedNonZero(args: string[]): boolean {
  const joined = args.join(" ");
  return (
    joined.includes("test -S /var/run/docker.sock") ||
    joined.includes("wget -qO-") ||
    joined.includes("timeout -s KILL")
  );
}

async function cleanupContainer(): Promise<boolean> {
  const removed = await docker(["rm", "-f", containerName]).catch(() => undefined);
  return removed?.exitCode === 0;
}

async function writeSummary(summary: ProbeSummary): Promise<void> {
  summary.cleanup_removed_container = cleanupRemovedContainer;
  await writeFile(
    join(OUT_DIR, "_e2-docker-operations-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
}

function summaryPasses(summary: ProbeSummary): boolean {
  return (
    summary.container_started &&
    summary.isolation_bar.non_root_user &&
    summary.isolation_bar.network_none &&
    summary.isolation_bar.read_only_rootfs &&
    summary.isolation_bar.workspace_tmpfs &&
    summary.isolation_bar.no_docker_socket &&
    summary.isolation_bar.cap_drop_all &&
    summary.isolation_bar.no_new_privileges &&
    summary.bash_exec.streamed_stdout_chunks >= 2 &&
    summary.bash_exec.first_chunk_before_exit &&
    summary.file_ops.exec_per_op.write_read_ok &&
    summary.file_ops.exec_per_op.edit_ok &&
    summary.file_ops.exec_per_op.list_ok &&
    summary.file_ops.exec_per_op.find_ok &&
    summary.network.denied
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
