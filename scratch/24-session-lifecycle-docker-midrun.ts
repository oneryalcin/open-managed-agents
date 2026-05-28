/**
 * Probe 24 — Session lifecycle (archive + delete) against a LIVE mid-run
 *            Docker-local session.
 *
 * Goal:
 *   The unit tests pin the lifecycle contract with a fake sandbox whose
 *   dispose() just flips a flag. They do NOT prove that archiving/deleting a
 *   session whose Pi turn is mid-flight actually tears down the real Docker
 *   container. This probe closes exactly that gap, through the real HTTP app.
 *
 *   For archive it:
 *     1. creates a session and kicks off a turn whose bash command sleeps, so
 *        the labelled container is genuinely alive,
 *     2. waits until the container is observed (turn is mid-run),
 *     3. issues the archive call, and
 *     4. asserts archive rejects while running and does not tear down runtime.
 *
 *   ARCHIVE (soft): HTTP 400 invalid_request_error while running,
 *     archived_at remains null, and the container remains alive. The probe then
 *     deletes the session for cleanup.
 *
 *   For delete it follows the same mid-run setup and asserts the real
 *   container is gone plus the hard cleanup contract:
 *
 *   DELETE (hard): returns {id, type:"session_deleted"}, container removed,
 *     GET /sessions/:id -> 404, GET /events -> 404, POST /events -> 404,
 *     second DELETE -> 404 (consistent), and a live SSE stream receives
 *     session.deleted before closing.
 *
 * Manual smoke: needs Docker + ANTHROPIC_API_KEY (Pi must choose bash).
 *
 * Run:
 *   ANTHROPIC_API_KEY=... npx tsx scratch/24-session-lifecycle-docker-midrun.ts
 */

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDeploymentControlPlaneApp } from "../src/control-plane/app.ts";

const OUT_DIR = join(process.cwd(), "scratch", "artifacts", "session-lifecycle-smoke");
const RUN_ID = Math.random().toString(36).slice(2, 8).toUpperCase();

const dockerAvailable =
  spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
  }).status === 0;

if (!dockerAvailable) {
  await emit({ verdict: "SKIPPED_NO_DOCKER", note: "docker not available" });
  process.exit(0);
}

const app = createDeploymentControlPlaneApp({
  OMA_SANDBOX_PROVIDER: "docker-local",
  OMA_ALLOW_DOCKER_LOCAL: "true",
});

const createdSessions: string[] = [];
let archiveResult: Record<string, unknown> = {};
let deleteResult: Record<string, unknown> = {};

try {
  archiveResult = await runArchiveCase();
  deleteResult = await runDeleteCase();
} finally {
  for (const id of createdSessions) forceRemoveBySession(id);
}

const verdict =
  archiveResult.pass === true && deleteResult.pass === true ? "PASS" : "FAIL";
await emit({
  verdict,
  run_id: RUN_ID,
  archive: archiveResult,
  delete: deleteResult,
});
if (verdict !== "PASS") process.exitCode = 1;

// --- cases ---

async function runArchiveCase(): Promise<Record<string, unknown>> {
  const sessionId = await startMidRunSession(`ARCHIVE_${RUN_ID}`);
  const containerSeen = await waitForContainer(sessionId, true, 30_000);

  const archive = await req("POST", `/v1/sessions/${sessionId}/archive`);
  const archiveError = archive.body as {
    error?: { type?: unknown; message?: unknown };
  };
  const containerStillPresent =
    (await waitForContainer(sessionId, true, 1_000)) === true;
  const getAfter = await req("GET", `/v1/sessions/${sessionId}`);
  const active = getAfter.body as Record<string, unknown>;
  const cleanupDelete = await req("DELETE", `/v1/sessions/${sessionId}`);
  const containerGoneAfterCleanup =
    (await waitForContainer(sessionId, false, 15_000)) === false;
  const expectedMessage = `Session ${sessionId} cannot be archived while its status is "running". Only pending or idle sessions may be archived.`;

  return {
    session_id: sessionId,
    container_observed_midrun: containerSeen,
    archive_status: archive.status,
    archive_error_type: archiveError.error?.type ?? null,
    archive_error_message: archiveError.error?.message ?? null,
    archived_at_after_reject: active?.archived_at ?? null,
    container_still_present_after_reject: containerStillPresent,
    get_after_status: getAfter.status, // expect 200
    cleanup_delete_status: cleanupDelete.status,
    container_removed_after_cleanup: containerGoneAfterCleanup,
    pass:
      containerSeen &&
      archive.status === 400 &&
      archiveError.error?.type === "invalid_request_error" &&
      archiveError.error?.message === expectedMessage &&
      getAfter.status === 200 &&
      active?.archived_at === null &&
      containerStillPresent &&
      cleanupDelete.status === 200 &&
      containerGoneAfterCleanup,
  };
}

async function runDeleteCase(): Promise<Record<string, unknown>> {
  const sessionId = await startMidRunSession(`DELETE_${RUN_ID}`);
  const containerSeen = await waitForContainer(sessionId, true, 30_000);
  const streamRes = await app.request(`/v1/sessions/${sessionId}/events/stream`);
  const streamTextPromise = streamRes.text();
  await delay(250);

  const del = await req("DELETE", `/v1/sessions/${sessionId}`);
  const streamText = await withTimeout(streamTextPromise, 10_000);
  const deleted = del.body as Record<string, unknown>;
  const containerGone = (await waitForContainer(sessionId, false, 15_000)) === false;

  const getAfter = await req("GET", `/v1/sessions/${sessionId}`);
  const eventsAfter = await req("GET", `/v1/sessions/${sessionId}/events`);
  const sendAfter = await req("POST", `/v1/sessions/${sessionId}/events`, {
    events: [{ type: "user.message", content: [{ type: "text", text: "again" }] }],
  });
  const reDelete = await req("DELETE", `/v1/sessions/${sessionId}`);

  return {
    session_id: sessionId,
    container_observed_midrun: containerSeen,
    delete_status: del.status,
    deleted_type: deleted?.type ?? null,
    stream_status: streamRes.status,
    stream_contains_deleted: streamText.includes("event: session.deleted"),
    stream_closed: streamText.length > 0,
    container_removed: containerGone,
    get_after_status: getAfter.status, // expect 404
    events_after_status: eventsAfter.status, // expect 404
    send_after_status: sendAfter.status, // expect 404
    redelete_status: reDelete.status, // expect 404 consistent
    pass:
      containerSeen &&
      del.status === 200 &&
      deleted?.type === "session_deleted" &&
      streamRes.status === 200 &&
      streamText.includes("event: session.deleted") &&
      containerGone &&
      getAfter.status === 404 &&
      eventsAfter.status === 404 &&
      sendAfter.status === 404 &&
      reDelete.status === 404,
  };
}

// --- session bootstrap ---

async function startMidRunSession(marker: string): Promise<string> {
  const agent = (await mustCreate("/v1/agents", {
    name: `probe24-${marker}`,
    model: "claude-opus-4-7",
    tools: [{ type: "agent_toolset_20260401" }],
  })) as { id: string };
  const environment = (await mustCreate("/v1/environments", {
    name: `probe24-${marker}`,
    config: { type: "cloud", networking: { type: "unrestricted" } },
  })) as { id: string };
  const session = (await mustCreate("/v1/sessions", {
    agent: agent.id,
    environment_id: environment.id,
  })) as { id: string };
  createdSessions.push(session.id);

  // Fire-and-forget turn: a sleeping bash command keeps the container alive
  // long enough to issue the lifecycle call mid-run. POST returns immediately.
  await req("POST", `/v1/sessions/${session.id}/events`, {
    events: [
      {
        type: "user.message",
        content: [
          {
            type: "text",
            text: [
              "Use the bash tool exactly once.",
              `Run this exact command: sleep 8; printf '${marker}'`,
              "Do not answer from memory; use the bash tool.",
            ].join(" "),
          },
        ],
      },
    ],
  });
  return session.id;
}

// --- docker helpers ---

async function waitForContainer(
  sessionId: string,
  wantPresent: boolean,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const present = containersForSession(sessionId).length > 0;
    if (present === wantPresent) return present;
    await delay(250);
  }
  return containersForSession(sessionId).length > 0;
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

// --- http + misc helpers ---

async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: unknown = undefined;
  const text = await res.text();
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

async function mustCreate(path: string, body: unknown): Promise<unknown> {
  const res = await req("POST", path, body);
  if (res.status !== 200) {
    throw new Error(`create ${path} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function emit(summary: Record<string, unknown>): Promise<void> {
  const payload = { generated_at: new Date().toISOString(), ...summary };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    join(OUT_DIR, "_session-lifecycle-midrun-summary.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  console.log(JSON.stringify(payload, null, 2));
}
