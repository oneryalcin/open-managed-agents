/**
 * Probe 40 — Docker-local parallel sandbox smoke.
 *
 * Goal:
 *   Exercise the current local worker shape without spending model tokens:
 *   one Docker-local sandbox per session, multiple sessions created and used
 *   concurrently, isolated /workspace and /mnt/session/outputs contents, and
 *   cleanup after provider disposal.
 *
 * Run:
 *   make parallel-docker-smoke
 *   OMA_PARALLEL_SMOKE_SESSIONS=5 make parallel-docker-smoke
 */

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDockerSandboxProviderFactory } from "../src/control-plane/sessions/pi/sandbox/docker.ts";
import type {
  SandboxOutputFile,
  SandboxProvider,
} from "../src/control-plane/sessions/pi/sandbox/provider.ts";

const OUT_DIR = join(process.cwd(), "scratch", "artifacts", "parallel-docker-smoke");
const WORKSPACE_ID = "wrk_default";
const RUN_ID = `probe40_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const SESSION_COUNT = parseSessionCount(process.env.OMA_PARALLEL_SMOKE_SESSIONS);
const LABEL_KEY = "open-managed-agents.parallel-smoke-id";

interface SessionResult {
  session_id: string;
  index: number;
  stdout: string;
  exit_code: number | null;
  output_files: Array<{
    relative_path: string;
    filename: string;
    text: string;
    size_bytes: number;
  }>;
  pass: boolean;
  errors: string[];
}

if (!dockerAvailable()) {
  const summary = {
    generated_at: new Date().toISOString(),
    run_id: RUN_ID,
    docker_available: false,
    verdict: "FAIL",
    reason: "Docker daemon is not available",
  };
  await writeSummary(summary);
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}

const factory = createDockerSandboxProviderFactory({
  extraLabels: { [LABEL_KEY]: RUN_ID },
  operationTimeoutMs: 15_000,
});

const sessionIds = Array.from(
  { length: SESSION_COUNT },
  (_, index) => `sesn_probe40_${RUN_ID}_${index}`,
);

const results = await Promise.all(
  sessionIds.map((sessionId, index) => runSession(sessionId, index)),
);
const leftovers = containersForRun();
for (const name of leftovers) {
  forceRemoveContainer(name);
}

const summary = {
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  docker_available: true,
  session_count: SESSION_COUNT,
  sessions: results,
  leftover_containers_after_dispose: leftovers,
  cleaned_up: leftovers.length === 0,
  verdict:
    results.every((result) => result.pass) && leftovers.length === 0
      ? "PASS"
      : "FAIL",
};

await writeSummary(summary);
console.log(JSON.stringify(summary, null, 2));
if (summary.verdict === "FAIL") process.exitCode = 1;

async function runSession(
  sessionId: string,
  index: number,
): Promise<SessionResult> {
  let provider: SandboxProvider | undefined;
  const chunks: Buffer[] = [];
  const errors: string[] = [];
  try {
    provider = await factory(WORKSPACE_ID, sessionId);
    const command = [
      "set -eu",
      "mkdir -p /mnt/session/outputs",
      `printf '%s\\n' '${sessionId}' > /mnt/session/outputs/session.txt`,
      `printf '%s\\n' 'index=${index}' > /mnt/session/outputs/index.txt`,
      `printf '%s' 'session=${sessionId} index=${index} docker='`,
      "if [ -f /.dockerenv ]; then printf yes; else printf no; fi",
      "printf ' pwd='",
      "pwd",
      "sleep 0.2",
    ].join("; ");
    const { exitCode } = await provider.operations.bash.exec(
      command,
      provider.cwd,
      {
        env: {},
        onData: (chunk: Buffer) => chunks.push(chunk),
        timeout: 10,
      },
    );
    const stdout = Buffer.concat(chunks).toString("utf8");
    const outputFiles = await collectOutputTexts(provider);
    const byRelativePath = new Map(
      outputFiles.map((file) => [file.relative_path, file]),
    );
    if (exitCode !== 0) errors.push(`bash exit code ${exitCode}`);
    if (!stdout.includes(`session=${sessionId} index=${index} docker=yes pwd=/workspace`)) {
      errors.push("stdout did not prove Docker-local /workspace execution");
    }
    if (byRelativePath.get("session.txt")?.text !== `${sessionId}\n`) {
      errors.push("session output file did not match this session id");
    }
    if (byRelativePath.get("index.txt")?.text !== `index=${index}\n`) {
      errors.push("index output file did not match this session index");
    }
    return {
      session_id: sessionId,
      index,
      stdout,
      exit_code: exitCode,
      output_files: outputFiles,
      pass: errors.length === 0,
      errors,
    };
  } catch (error) {
    return {
      session_id: sessionId,
      index,
      stdout: Buffer.concat(chunks).toString("utf8"),
      exit_code: null,
      output_files: [],
      pass: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  } finally {
    provider?.dispose();
  }
}

async function collectOutputTexts(
  provider: SandboxProvider,
): Promise<SessionResult["output_files"]> {
  const files = await provider.collectOutputFiles?.();
  if (!files) return [];
  return Promise.all(
    files.map(async (file) => ({
      relative_path: file.relativePath,
      filename: file.filename,
      text: (await outputBytes(file)).toString("utf8"),
      size_bytes: file.sizeBytes,
    })),
  );
}

async function outputBytes(file: SandboxOutputFile): Promise<Buffer> {
  if (file.bytes instanceof Uint8Array) return Buffer.from(file.bytes);
  const chunks: Buffer[] = [];
  for await (const chunk of file.bytes) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function dockerAvailable(): boolean {
  return (
    spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      encoding: "utf8",
    }).status === 0
  );
}

function containersForRun(): string[] {
  const result = spawnSync(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `label=${LABEL_KEY}=${RUN_ID}`,
      "--format",
      "{{.Names}}",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return [`<docker ps failed: ${result.stderr.trim()}>`];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function forceRemoveContainer(name: string): void {
  if (name.startsWith("<docker ps failed:")) return;
  spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
}

function parseSessionCount(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 3;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 20) {
    throw new Error("OMA_PARALLEL_SMOKE_SESSIONS must be an integer from 1 to 20");
  }
  return parsed;
}

async function writeSummary(summary: unknown): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    join(OUT_DIR, "_parallel-docker-smoke-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
}
