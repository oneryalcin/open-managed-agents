/**
 * Probe 27 — File resources materialized into Docker-local before sessions.create
 *            returns.
 *
 * Forcing function:
 *   https://github.com/oneryalcin/open-managed-agents/issues/43
 *
 * This probe is intentionally skipped until issue #43 lands. PR #1 only adds
 * the Files API and in-memory FileStorage boundary; it does not yet accept
 * sessions.create resources[] or materialize bytes into Docker.
 *
 * Acceptance once unskipped by #43:
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
 * Run after #43:
 *   OMA_RUN_FILE_RESOURCE_MATERIALIZATION_PROBE=true \
 *   ANTHROPIC_API_KEY=... \
 *   npx tsx scratch/27-file-resource-docker-materialization.ts
 */

import { File } from "node:buffer";
import { createDeploymentControlPlaneApp } from "../src/control-plane/app.ts";

const ISSUE_URL =
  "https://github.com/oneryalcin/open-managed-agents/issues/43";
const PAYLOAD = "OMA_FILE_RESOURCE_PROBE=ok\n";
const MOUNT_PATH = "/mnt/session/uploads/probe.txt";
const COMMAND = `cat ${MOUNT_PATH}`;

if (process.env.OMA_RUN_FILE_RESOURCE_MATERIALIZATION_PROBE !== "true") {
  console.log(
    JSON.stringify(
      {
        verdict: "SKIP",
        reason: "Docker-local file resource materialization is tracked by #43",
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
});
const file = await uploadFile("probe.txt", PAYLOAD, "text/plain");
const session = await postJson("/v1/sessions", {
  agent: agent.id,
  environment_id: environment.id,
  title: "file-resource-probe",
  resources: [{ type: "file", file_id: file.id, mount_path: "probe.txt" }],
});

await request(`/v1/files/${file.id}?beta=true`, { method: "DELETE" });

console.log(
  JSON.stringify(
    {
      verdict: "TODO_UNTIL_43",
      issue: ISSUE_URL,
      session_id: session.id,
      uploaded_file_id: file.id,
      command: COMMAND,
      expected_tool_result_text: PAYLOAD,
      note:
        "After #43, extend this probe to stream/send events and assert agent.tool_use + agent.tool_result directly.",
    },
    null,
    2,
  ),
);

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
