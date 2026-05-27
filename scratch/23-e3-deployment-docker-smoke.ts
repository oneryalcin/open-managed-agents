/**
 * Probe 23 — Cycle E.3 deployment Docker-local smoke + isolation discriminator.
 *
 * Goal:
 *   Prove that the *deployment* config path (env -> deployment runtime config ->
 *   runner/provider) actually executes inside Docker, and that the in-Docker
 *   signals are real discriminators rather than tautological self-reports.
 *
 *   Two independent halves:
 *
 *   1. DETERMINISTIC DISCRIMINATOR (no model, the durable regression guard):
 *      Build the provider factory straight from deployment env for BOTH
 *      docker-local and host-passthrough, run the *same* bash command via the
 *      provider's operations directly, and assert the outputs differ in the way
 *      isolation requires:
 *        docker-local    -> IN_DOCKER=yes  PWD=/workspace
 *        host-passthrough-> IN_DOCKER=no   PWD=<host tmpdir, not /workspace>
 *      The host-passthrough run is the negative control: it proves /.dockerenv
 *      and PWD=/workspace are genuine discriminators, not always-true strings.
 *
 *   2. MODEL-DRIVEN SERVED PATH (docker-local only, manual/model-dependent):
 *      Drive the deployment runner with Pi, translate the raw Pi events exactly
 *      as app.ts wires them (runner + translatePiEvent), and assert the served
 *      agent.tool_use / agent.tool_result contract — exactly one bash call with
 *      the exact command, a matching tool_use_id, is_error=false, and the exact
 *      in-Docker output. Then assert the labelled container is cleaned up.
 *
 * This is a manual smoke (half 2 calls the model). Half 1 is deterministic and
 * is the part that locks the discriminator.
 *
 * Run:
 *   ANTHROPIC_API_KEY=... npx tsx scratch/23-e3-deployment-docker-smoke.ts
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDeploymentPiSessionRunner,
  parseDeploymentRuntimeConfigFromEnv,
  type DeploymentRuntimeEnv,
} from "../src/control-plane/deployment-runtime-config.ts";
import {
  resolveSandboxProviderFactory,
  type SandboxProviderSelectionResolverOptions,
} from "../src/control-plane/sessions/pi/sandbox/selection.ts";
import type { SandboxProviderFactory } from "../src/control-plane/sessions/pi/sandbox/provider.ts";
import {
  translatePiEvent,
  type EventDraft,
} from "../src/control-plane/sessions/pi/translator.ts";

const OUT_DIR = join(process.cwd(), "scratch", "artifacts", "deployment-docker-smoke");
const RUN_ID = Math.random().toString(36).slice(2, 8).toUpperCase();
const MARKER = `OMA_DEPLOY_DOCKER_${RUN_ID}`;
const WORKSPACE_ID = "wrk_default";
const SESSION_ID = `sesn_probe23_${RUN_ID.toLowerCase()}`;

// One exact command, used everywhere. Output is the discriminator:
//   "<MARKER> IN_DOCKER=<yes|no> PWD=<cwd>\n"
const CMD =
  `printf '${MARKER} IN_DOCKER='; ` +
  `if [ -f /.dockerenv ]; then printf yes; else printf no; fi; ` +
  `printf ' PWD='; pwd`;
const EXPECTED_DOCKER_OUTPUT = `${MARKER} IN_DOCKER=yes PWD=/workspace\n`;

const dockerEnv: DeploymentRuntimeEnv = {
  OMA_SANDBOX_PROVIDER: "docker-local",
  OMA_ALLOW_DOCKER_LOCAL: "true",
};

const dockerAvailable =
  spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
  }).status === 0;

const hostWorkspaceRoot = await mkdtemp(join(tmpdir(), "oma-probe23-host-"));

const notes: string[] = [];
let discriminator: Record<string, unknown> | null = null;
let served: Record<string, unknown> | null = null;
let cleanup: Record<string, unknown> | null = null;

try {
  // --- Half 1: deterministic discriminator (negative control included) ---
  const hostResult = await bashViaProviderFromEnv(
    {
      OMA_SANDBOX_PROVIDER: "host-passthrough",
      OMA_UNSAFE_ALLOW_HOST_PASSTHROUGH: "true",
      OMA_ALLOW_UNSAFE_HOST_PASSTHROUGH: "true",
      OMA_HOST_PASSTHROUGH_WORKSPACE_ROOT: hostWorkspaceRoot,
    },
    `${WORKSPACE_ID}`,
    `${SESSION_ID}_host`,
  );
  const hostMatch = /^.+ IN_DOCKER=(yes|no) PWD=(.+)\n$/.exec(hostResult.output);
  const hostInDocker = hostMatch?.[1];
  const hostPwd = hostMatch?.[2];

  if (dockerAvailable) {
    const dockerResult = await bashViaProviderFromEnv(
      dockerEnv,
      `${WORKSPACE_ID}`,
      `${SESSION_ID}_det`,
    );
    discriminator = {
      docker: {
        output: dockerResult.output,
        exit_code: dockerResult.exitCode,
        cwd: dockerResult.cwd,
        in_docker_yes: dockerResult.output.includes("IN_DOCKER=yes"),
        pwd_is_workspace: dockerResult.output.includes("PWD=/workspace\n"),
        exact_match: dockerResult.output === EXPECTED_DOCKER_OUTPUT,
      },
      host_negative_control: {
        output: hostResult.output,
        exit_code: hostResult.exitCode,
        provider_cwd: hostResult.cwd,
        in_docker_no: hostInDocker === "no",
        pwd_not_workspace: hostPwd !== undefined && hostPwd !== "/workspace",
      },
      // The discriminator is real only if BOTH signals flip between providers.
      discriminator_is_real:
        dockerResult.output === EXPECTED_DOCKER_OUTPUT &&
        hostInDocker === "no" &&
        hostPwd !== undefined &&
        hostPwd !== "/workspace",
    };
  } else {
    notes.push(
      "Docker unavailable: docker-local halves skipped. Host negative control still ran.",
    );
    discriminator = {
      docker: null,
      host_negative_control: {
        output: hostResult.output,
        exit_code: hostResult.exitCode,
        provider_cwd: hostResult.cwd,
        in_docker_no: hostInDocker === "no",
        pwd_not_workspace: hostPwd !== undefined && hostPwd !== "/workspace",
      },
      discriminator_is_real: false,
    };
  }

  // --- Half 2: model-driven served path through the deployment runner ---
  if (dockerAvailable) {
    const drafts = await runServedDockerTurn();
    const toolUses = drafts.filter((d) => d.type === "agent.tool_use");
    const toolResults = drafts.filter((d) => d.type === "agent.tool_result");
    const tu = toolUses[0]?.payload as Record<string, unknown> | undefined;
    const tr = toolResults[0]?.payload as Record<string, unknown> | undefined;
    const tuInput = isRecord(tu?.input) ? tu?.input : undefined;
    served = {
      event_types: drafts.map((d) => d.type),
      tool_use_count: toolUses.length,
      tool_result_count: toolResults.length,
      tool_name: tu?.name ?? null,
      command_exact: tuInput?.command === CMD,
      tool_use_id_match:
        tu?.tool_use_id !== undefined && tr?.tool_use_id === tu?.tool_use_id,
      is_error: tr?.is_error ?? null,
      tool_result_text: toolResultText(tr),
      tool_result_text_exact: toolResultText(tr) === EXPECTED_DOCKER_OUTPUT,
      pass:
        toolUses.length === 1 &&
        toolResults.length === 1 &&
        tu?.name === "bash" &&
        tuInput?.command === CMD &&
        tr?.tool_use_id === tu?.tool_use_id &&
        tr?.is_error === false &&
        toolResultText(tr) === EXPECTED_DOCKER_OUTPUT,
    };

    // --- Cleanup: idleTtlMs:0 + close() should dispose -> docker rm -f ---
    const leftover = await waitForContainerGone(SESSION_ID, 5_000);
    cleanup = {
      leftover_containers_after_close: leftover,
      cleaned_up: leftover.length === 0,
    };
  }
} finally {
  // Belt-and-braces: remove any container any half of this run could have left
  // behind (served + deterministic docker use distinct session ids), and the
  // host workspace tmpdir.
  for (const id of [SESSION_ID, `${SESSION_ID}_det`, `${SESSION_ID}_host`]) {
    forceRemoveBySession(id);
  }
  await rm(hostWorkspaceRoot, { force: true, recursive: true });
}

const verdict = computeVerdict();
const summary = {
  generated_at: new Date().toISOString(),
  marker: MARKER,
  session_id: SESSION_ID,
  command: CMD,
  docker_available: dockerAvailable,
  discriminator,
  served,
  cleanup,
  notes,
  verdict,
};

await mkdir(OUT_DIR, { recursive: true });
await writeFile(
  join(OUT_DIR, "_e3-deployment-docker-smoke-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
if (verdict === "FAIL") process.exitCode = 1;

// --- helpers ---

async function bashViaProviderFromEnv(
  env: DeploymentRuntimeEnv,
  workspaceId: string,
  sessionId: string,
): Promise<{ cwd: string; output: string; exitCode: number | null }> {
  const factory = factoryFromEnv(env);
  const provider = await factory(workspaceId, sessionId);
  let output = "";
  try {
    const { exitCode } = await provider.operations.bash.exec(CMD, provider.cwd, {
      env: {},
      onData: (chunk: Buffer) => {
        output += chunk.toString("utf8");
      },
      timeout: 30,
    });
    return { cwd: provider.cwd, output, exitCode };
  } finally {
    provider.dispose();
  }
}

function factoryFromEnv(env: DeploymentRuntimeEnv): SandboxProviderFactory {
  const config = parseDeploymentRuntimeConfigFromEnv(env);
  const factory = resolveSandboxProviderFactory(
    config.sandboxProviderSelection,
    config.sandboxProviderSelectionOptions as
      | SandboxProviderSelectionResolverOptions
      | undefined,
  );
  if (factory === undefined) {
    throw new Error("Expected a provider factory from deployment env");
  }
  return factory;
}

async function runServedDockerTurn(): Promise<EventDraft[]> {
  const config = parseDeploymentRuntimeConfigFromEnv(dockerEnv);
  const runner = createDeploymentPiSessionRunner(config, { idleTtlMs: 0 });
  const prompt = [
    "Use the bash tool exactly once.",
    `Run this exact command: ${CMD}`,
    "Do not answer from memory; use the bash tool.",
  ].join(" ");
  const drafts: EventDraft[] = [];
  try {
    for await (const raw of runner.runUserMessage(
      WORKSPACE_ID,
      SESSION_ID,
      prompt,
    )) {
      for (const draft of translatePiEvent(raw)) drafts.push(draft);
    }
  } finally {
    runner.close();
  }
  return drafts;
}

function toolResultText(payload: Record<string, unknown> | undefined): string {
  if (payload === undefined || !Array.isArray(payload.content)) return "";
  return payload.content
    .filter(isRecord)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

async function waitForContainerGone(
  sessionId: string,
  budgetMs: number,
): Promise<string[]> {
  const deadline = Date.now() + budgetMs;
  let leftover = containersForSession(sessionId);
  while (leftover.length > 0 && Date.now() < deadline) {
    await delay(200);
    leftover = containersForSession(sessionId);
  }
  return leftover;
}

function containersForSession(sessionId: string): string[] {
  const result = spawnSync(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `label=open-managed-agents.session-id=${sessionId}`,
      "--format",
      "{{.Names}}",
    ],
    { encoding: "utf8" },
  );
  return (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function forceRemoveBySession(sessionId: string): void {
  for (const name of containersForSession(sessionId)) {
    spawnSync("docker", ["rm", "-f", name]);
  }
}

function computeVerdict(): "PASS" | "FAIL" | "SKIPPED_NO_DOCKER" {
  if (!dockerAvailable) return "SKIPPED_NO_DOCKER";
  const discriminatorReal = discriminator?.discriminator_is_real === true;
  const servedPass = (served as Record<string, unknown> | null)?.pass === true;
  const cleanedUp = (cleanup as Record<string, unknown> | null)?.cleaned_up === true;
  return discriminatorReal && servedPass && cleanedUp ? "PASS" : "FAIL";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
