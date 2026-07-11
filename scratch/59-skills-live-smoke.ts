/** Slice-4 skills capstone: real Docker sandbox + real model turn. */
import { File } from "node:buffer";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createDeploymentControlPlaneApp } from "../src/control-plane/app.ts";

const ROOT = resolve("scratch/fixtures/oma-example-skill");
const SKILL_NAME = "oma-example-skill";
const SKILL_ROOT = `/workspace/skills/${SKILL_NAME}`;
const PROOF = "OMA_SKILLS_LIVE_PROOF=read-and-executed";
const HOST_CANARY = `OMA_SKILLS_HOST_SECRET_${crypto.randomUUID()}`;
const BETA = "managed-agents-2026-04-01,skills-2025-10-02";

if (process.env.OMA_RUN_SKILLS_LIVE_SMOKE !== "true") {
  console.log(JSON.stringify({ verdict: "SKIP", reason: "set OMA_RUN_SKILLS_LIVE_SMOKE=true" }, null, 2));
  process.exit(0);
}
if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY required");

const observedLogs: string[] = [];
const originalError = console.error;
const originalWarn = console.warn;
process.env.OMA_SKILLS_HOST_SECRET_CANARY = HOST_CANARY;
console.error = (...args) => { observedLogs.push(args.map(String).join(" ")); originalError(...args); };
console.warn = (...args) => { observedLogs.push(args.map(String).join(" ")); originalWarn(...args); };

const app = createDeploymentControlPlaneApp({
  ...process.env,
  OMA_SANDBOX_PROVIDER: "docker-local",
  OMA_ALLOW_DOCKER_LOCAL: "true",
});

let skillId: string | undefined;
let skillVersion: string | undefined;
let agentId: string | undefined;
let environmentId: string | undefined;
let sessionId: string | undefined;
let containerId: string | undefined;
try {
  const skill = await uploadSkill();
  skillId = String(skill.id); skillVersion = String(skill.latest_version);
  const agent = await postJson("/v1/agents", {
    name: `skills-live-${Date.now()}`,
    model: process.env.OMA_SKILLS_SMOKE_MODEL ?? "claude-sonnet-4-6",
    system: "Follow the attached skill exactly. Use the required read and bash tools; do not guess the proof text.",
    tools: [{ type: "agent_toolset_20260401", default_config: { enabled: true, permission_policy: { type: "always_allow" } } }],
    skills: [{ type: "custom", skill_id: skillId, version: "latest" }],
  });
  agentId = String(agent.id);
  const environment = await postJson("/v1/environments", { name: `skills-live-${Date.now()}`, config: { type: "cloud" } });
  environmentId = String(environment.id);
  const session = await postJson("/v1/sessions", { agent: agentId, environment_id: environmentId, title: "skills-live-smoke" });
  sessionId = String(session.id);
  containerId = dockerContainerForSession(sessionId);

  const before = dockerExec(containerId, ["sh", "-c", `find '${SKILL_ROOT}' -type f -print | sort; test -r '${SKILL_ROOT}/SKILL.md'; test -x '${SKILL_ROOT}/scripts/prove.sh'; test ! -w '${SKILL_ROOT}/SKILL.md'; test ! -w '${SKILL_ROOT}/scripts/prove.sh'; ! mv /workspace/skills /workspace/skills-away; ! env | grep -F '${HOST_CANARY}'; test ! -e /etc/oma/ca.crt`]);
  for (const expected of ["LICENSE", "SKILL.md", "scripts/prove.sh"]) {
    if (!before.stdout.includes(`${SKILL_ROOT}/${expected}`)) throw new Error(`missing mounted skill file: ${expected}`);
  }

  await requestJson(`/v1/skills/${skillId}/versions/${skillVersion}`, { method: "DELETE" });
  await sendEvents(sessionId, [{ type: "user.message", content: [{ type: "text", text: "Run the OMA skills smoke proof now." }] }]);
  const events = await waitForEvents(sessionId, (page) => page.data.some((event) => event.type === "agent.tool_result" && eventText(event).includes(PROOF)));
  const readUse = events.data.find((event) => event.type === "agent.tool_use" && JSON.stringify(event).includes(`${SKILL_ROOT}/SKILL.md`));
  const bashUse = events.data.find((event) => event.type === "agent.tool_use" && JSON.stringify(event).includes(`${SKILL_ROOT}/scripts/prove.sh`));
  const proofResult = events.data.find((event) => event.type === "agent.tool_result" && eventText(event).includes(PROOF));
  if (!readUse || !bashUse || !proofResult) throw new Error(`missing read/bash/proof evidence: ${JSON.stringify(events)}`);
  const eventTypes = [...new Set(events.data.map((event) => event.type))].sort();
  if (eventTypes.some((type) => type.toLowerCase().includes("skill"))) throw new Error(`unexpected skill event type: ${eventTypes.join(",")}`);
  const visible = JSON.stringify(events) + observedLogs.join("\n") + before.stdout + before.stderr;
  if (visible.includes(HOST_CANARY)) throw new Error("host secret canary leaked to an observable surface");

  const result = { verdict: "PASS", skill_id: skillId, concrete_version: skillVersion, session_id: sessionId, container_id: containerId, source_version_deleted_before_turn: true, read_tool_use: true, bash_tool_use: true, proof_tool_result: PROOF, event_types: eventTypes, host_secret_leaked: false, skill_files_non_writable: true, mountpoint_replaceable: false };
  mkdirSync(resolve("scratch/artifacts"), { recursive: true });
  writeFileSync(resolve("scratch/artifacts/59-skills-live-smoke.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (sessionId) await request(`/v1/sessions/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
  if (agentId) await request(`/v1/agents/${agentId}/archive`, { method: "POST" }).catch(() => undefined);
  if (environmentId) await request(`/v1/environments/${environmentId}`, { method: "DELETE" }).catch(() => undefined);
  if (skillId) {
    const versions = await request(`/v1/skills/${skillId}/versions`).then(async (res) => res.ok ? (await res.json()) as { data?: Array<{ version: string }> } : undefined).catch(() => undefined);
    for (const version of versions?.data ?? []) await request(`/v1/skills/${skillId}/versions/${version.version}`, { method: "DELETE" }).catch(() => undefined);
    await request(`/v1/skills/${skillId}`, { method: "DELETE" }).catch(() => undefined);
  }
  if (sessionId && dockerContainersForSession(sessionId).length !== 0) throw new Error(`container remained after cleanup: ${sessionId}`);
  console.error = originalError; console.warn = originalWarn;
}

async function uploadSkill(): Promise<Record<string, unknown>> {
  const form = new FormData();
  for (const path of ["SKILL.md", "LICENSE", "scripts/prove.sh"]) form.append("files[]", new File([readFileSync(resolve(ROOT, path))], `${SKILL_NAME}/${path}`));
  return requestJson("/v1/skills", { method: "POST", body: form });
}
async function postJson(path: string, body: Record<string, unknown>) { return requestJson(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
async function requestJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> { const res = await request(path, init); const body = await res.json() as Record<string, unknown>; if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`); return body; }
async function request(path: string, init?: RequestInit): Promise<Response> { const headers = new Headers(init?.headers); headers.set("anthropic-beta", BETA); return app.request(path, { ...init, headers }); }
async function sendEvents(id: string, events: unknown[]) { await requestJson(`/v1/sessions/${id}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events }) }); }
async function listEvents(id: string) { return requestJson(`/v1/sessions/${id}/events?order=asc&limit=200`) as Promise<{ data: Array<Record<string, unknown> & { type: string }> }>; }
async function waitForEvents(id: string, predicate: (page: { data: Array<Record<string, unknown> & { type: string }> }) => boolean) { const deadline = Date.now() + 90_000; while (Date.now() < deadline) { const page = await listEvents(id); if (predicate(page)) return page; await new Promise((resolve) => setTimeout(resolve, 750)); } throw new Error("timed out waiting for skill proof events"); }
function dockerContainersForSession(id: string) { const result = spawnSync("docker", ["ps", "-aq", "--filter", `label=open-managed-agents.session-id=${id}`], { encoding: "utf8" }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.split("\n").filter(Boolean); }
function dockerContainerForSession(id: string) { const ids = dockerContainersForSession(id); if (ids.length !== 1) throw new Error(`expected one container, got ${ids.length}`); return ids[0]!; }
function dockerExec(id: string, args: string[]) { const result = spawnSync("docker", ["exec", id, ...args], { encoding: "utf8" }); if (result.status !== 0) throw new Error(`docker exec failed: ${result.stderr || result.stdout}`); return result; }
function eventText(event: Record<string, unknown>) { const content = event.content; return Array.isArray(content) ? content.map((block) => typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "").join("") : ""; }
