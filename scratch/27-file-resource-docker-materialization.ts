/**
 * Probe 27 — File resources materialized into Docker-local before sessions.create
 *            returns.
 *
 * Forcing function:
 *   https://github.com/oneryalcin/open-managed-agents/issues/50
 *
 * Acceptance:
 *   1. Upload a tiny input file through /v1/files.
 *   2. Create a Docker-local deployment app with file resources enabled.
 *   3. Create a session with resources=[{type:"file", file_id, mount_path:"probe.txt"}].
 *   4. Assert sessions.create returns only after /mnt/session/uploads/probe.txt
 *      is present in the container.
 *   5. Delete the original uploaded file and prove the session-scoped snapshot
 *      still works.
 *   6. Send a user.message that asks for this exact command:
 *        cat /mnt/session/uploads/probe.txt
 *      Then assert agent.tool_use / agent.tool_result directly, including the
 *      exact command and exact file bytes.
 *
 * Run:
 *   OMA_RUN_FILE_RESOURCE_MATERIALIZATION_PROBE=true \
 *   ANTHROPIC_API_KEY=... \
 *   npx tsx scratch/27-file-resource-docker-materialization.ts
 */

import { File } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createDeploymentControlPlaneApp } from "../src/control-plane/app.ts";

const ISSUE_URL =
  "https://github.com/oneryalcin/open-managed-agents/issues/50";
const PAYLOAD = "OMA_FILE_RESOURCE_PROBE=ok\n";
const MOUNT_PATH = "/mnt/session/uploads/probe.txt";
const COMMAND = `cat ${MOUNT_PATH}`;

if (process.env.OMA_RUN_FILE_RESOURCE_MATERIALIZATION_PROBE !== "true") {
  console.log(
    JSON.stringify(
      {
        verdict: "SKIP",
        reason: "set OMA_RUN_FILE_RESOURCE_MATERIALIZATION_PROBE=true",
        issue: ISSUE_URL,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const app = createDeploymentControlPlaneApp({
  ...process.env,
  OMA_SANDBOX_PROVIDER: "docker-local",
  OMA_ALLOW_DOCKER_LOCAL: "true",
});

const agent = await postJson("/v1/agents", {
  name: "file-resource-probe",
  model: process.env.OMA_RESOURCE_PROBE_MODEL ?? "claude-sonnet-4-6",
  system: `Use bash to run exactly ${COMMAND} when asked. Reply with exactly the file contents and nothing else.`,
  tools: [
    {
      type: "agent_toolset_20260401",
      default_config: {
        enabled: true,
        permission_policy: { type: "always_allow" },
      },
    },
  ],
});
const environment = await postJson("/v1/environments", {
  name: "file-resource-probe",
  config: { type: "cloud" },
});
const file = await uploadFile("probe.txt", PAYLOAD, "text/plain");
const session = await postJson("/v1/sessions", {
  agent: agent.id,
  environment_id: environment.id,
  title: "file-resource-probe",
  resources: [{ type: "file", file_id: file.id, mount_path: "probe.txt" }],
});

if (
  !Array.isArray(session.resources) ||
  session.resources.length !== 1 ||
  session.resources[0]?.id === undefined ||
  session.resources[0]?.type !== "file" ||
  session.resources[0]?.file_id !== file.id ||
  session.resources[0]?.mount_path !== MOUNT_PATH
) {
  throw new Error(`unexpected session resources: ${JSON.stringify(session)}`);
}
const containerId = dockerContainerForSession(session.id);
const mountedPayload = dockerExecText(containerId, ["cat", MOUNT_PATH]);
if (mountedPayload !== PAYLOAD) {
  throw new Error(
    `mounted payload mismatch before create returned: ${JSON.stringify(mountedPayload)}`,
  );
}

await request(`/v1/files/${file.id}?beta=true`, { method: "DELETE" });

await sendEvents(session.id, [
  {
    type: "user.message",
    content: [
      {
        type: "text",
        text: `Use bash to run exactly this command: ${COMMAND}`,
      },
    ],
  },
]);

const events = await waitForEvents(session.id, (page) =>
  page.data.some(
    (event) => event.type === "agent.tool_result" &&
      eventText(event).includes(PAYLOAD),
  ),
);
const toolUse = events.data.find(
  (event) => event.type === "agent.tool_use" &&
    JSON.stringify(event).includes(COMMAND),
);
if (!toolUse) {
  throw new Error(`missing agent.tool_use for ${COMMAND}: ${JSON.stringify(events)}`);
}
const toolResult = events.data.find(
  (event) => event.type === "agent.tool_result" &&
    eventText(event).includes(PAYLOAD),
);
if (!toolResult) {
  throw new Error(
    `missing agent.tool_result with mounted bytes: ${JSON.stringify(events)}`,
  );
}

await deleteSession(session.id);
if (dockerContainersForSession(session.id).length !== 0) {
  throw new Error(`container remained after session delete: ${session.id}`);
}

console.log(
  JSON.stringify(
    {
      verdict: "PASS",
      issue: ISSUE_URL,
      session_id: session.id,
      uploaded_file_id: file.id,
      container_id: containerId,
      command: COMMAND,
      expected_tool_result_text: PAYLOAD,
    },
    null,
    2,
  ),
);
process.exit(0);

async function uploadFile(
  filename: string,
  content: string,
  mimeType: string,
): Promise<Record<string, string>> {
  const form = new FormData();
  form.set("file", new File([content], filename, { type: mimeType }));
  return requestJson("/v1/files?beta=true", {
    method: "POST",
    body: form,
  });
}

async function postJson(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, string>> {
  return requestJson(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function requestJson(
  path: string,
  init?: RequestInit,
): Promise<Record<string, string>> {
  const res = await request(path, init);
  const body = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(JSON.stringify(body));
  }
  return body as Record<string, string>;
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, init);
}

async function deleteSession(sessionId: string): Promise<void> {
  const res = await request(`/v1/sessions/${sessionId}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`session delete failed: ${res.status} ${await res.text()}`);
  }
}

async function sendEvents(sessionId: string, events: unknown[]): Promise<void> {
  const res = await request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events }),
  });
  if (!res.ok) {
    throw new Error(`events.send failed: ${res.status} ${await res.text()}`);
  }
}

async function listEvents(sessionId: string): Promise<{
  data: Array<Record<string, unknown> & { type: string }>;
}> {
  const res = await request(
    `/v1/sessions/${sessionId}/events?order=asc&limit=100`,
  );
  if (!res.ok) {
    throw new Error(`events.list failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as {
    data: Array<Record<string, unknown> & { type: string }>;
  };
}

async function waitForEvents(
  sessionId: string,
  predicate: (page: { data: Array<Record<string, unknown> & { type: string }> }) => boolean,
): Promise<{ data: Array<Record<string, unknown> & { type: string }> }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    const page = await listEvents(sessionId);
    if (predicate(page)) return page;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return listEvents(sessionId);
}

function dockerContainerForSession(sessionId: string): string {
  const ids = dockerContainersForSession(sessionId);
  if (ids.length !== 1) {
    throw new Error(`expected one Docker container for ${sessionId}, got ${ids.length}`);
  }
  return ids[0]!;
}

function dockerContainersForSession(sessionId: string): string[] {
  const result = spawnSync(
    "docker",
    [
      "ps",
      "-aq",
      "--filter",
      `label=open-managed-agents.session-id=${sessionId}`,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`docker ps failed: ${result.stderr}`);
  }
  return result.stdout.split("\n").filter(Boolean);
}

function dockerExecText(containerId: string, args: string[]): string {
  const result = spawnSync("docker", ["exec", containerId, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`docker exec failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function eventText(event: Record<string, unknown>): string {
  const content = event.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}
