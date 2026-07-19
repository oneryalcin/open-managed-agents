import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDeploymentControlPlaneApp,
  MANAGED_AGENTS_BETA_HEADERS,
} from "./helpers.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "oma-deployment-models-"));
  roots.push(root);
  return root;
}

describe("deployment model catalog admission", () => {
  it("rejects disabled providers before persisting an agent", async () => {
    const app = createDeploymentControlPlaneApp({
      OMA_HOME: home(),
      OMA_MODEL_PROVIDERS: "anthropic",
    });

    const rejected = await app.request("/v1/agents", {
      method: "POST",
      headers: {
        ...MANAGED_AGENTS_BETA_HEADERS,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "OpenAI Agent",
        model: { provider: "openai", id: "gpt-5" },
      }),
    });

    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Model provider openai is not enabled on this deployment",
      },
    });
    const listed = await app.request("/v1/agents");
    expect(((await listed.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it("rejects an unknown exact pair before persisting an agent", async () => {
    const app = createDeploymentControlPlaneApp({ OMA_HOME: home() });

    const rejected = await app.request("/v1/agents", {
      method: "POST",
      headers: {
        ...MANAGED_AGENTS_BETA_HEADERS,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Unknown Model Agent",
        model: { provider: "anthropic", id: "not-a-real-model" },
      }),
    });

    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Model anthropic/not-a-real-model is not available on this deployment",
      },
    });
    const listed = await app.request("/v1/agents");
    expect(((await listed.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it("rejects a registered model without credentials before persisting a session", async () => {
    const root = home();
    const piRoot = join(root, "pi");
    mkdirSync(piRoot, { mode: 0o700 });
    writeFileSync(
      join(piRoot, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: "http://localhost:11434",
            api: "openai-responses",
            models: [{
              id: "local-model",
              name: "Local model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 2048,
            }],
          },
        },
      }),
      { mode: 0o600 },
    );
    const app = createDeploymentControlPlaneApp({
      OMA_HOME: root,
      OMA_MODEL_PROVIDERS: "anthropic,local",
    });
    const agent = await postJson(app, "/v1/agents", {
      name: "Local Agent",
      model: { provider: "local", id: "local-model" },
    });
    expect(agent.status).toBe(200);
    const agentId = ((await agent.json()) as { id: string }).id;
    const environment = await postJson(app, "/v1/environments", {
      name: "Local Environment",
      config: { type: "cloud" },
    });
    expect(environment.status).toBe(200);
    const environmentId = ((await environment.json()) as { id: string }).id;

    const rejected = await postJson(app, "/v1/sessions", {
      agent: agentId,
      environment_id: environmentId,
    });

    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: "Credentials for model provider local are not configured on this deployment",
      },
    });
    const sessions = await app.request("/v1/sessions");
    expect(((await sessions.json()) as { data: unknown[] }).data).toEqual([]);
  });
});

async function postJson(
  app: ReturnType<typeof createDeploymentControlPlaneApp>,
  path: string,
  body: unknown,
): Promise<Response> {
  return await app.request(path, {
    method: "POST",
    headers: {
      ...MANAGED_AGENTS_BETA_HEADERS,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
