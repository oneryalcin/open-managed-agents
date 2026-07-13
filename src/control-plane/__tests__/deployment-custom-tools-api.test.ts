import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PiRuntimeSession } from "../sessions/pi/runner.ts";

const sdk = vi.hoisted(() => {
  type MockToolDefinition = { name: string };
  type MockCreateOptions = {
    noTools?: "all" | "builtin";
    tools?: string[];
    customTools?: MockToolDefinition[];
  };
  let lastCreateOptions: MockCreateOptions | undefined;

  class MockAuthStorage {
    static create(): Record<string, never> {
      return {};
    }
  }

  class MockModelRegistry {
    static create(): { find: () => { id: string } } {
      return { find: () => ({ id: "mock-model" }) };
    }
  }

  class MockSession implements PiRuntimeSession {
    private readonly listeners = new Set<(event: unknown) => void>();

    async prompt(text: string): Promise<void> {
      this.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `runtime: ${text}` }],
          stopReason: "stop",
        },
      });
    }

    async followUp(): Promise<void> {}

    async abort(): Promise<void> {}

    dispose(): void {
      this.listeners.clear();
    }

    subscribe(listener: (event: unknown) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    getActiveToolNames(): string[] {
      return lastCreateOptions?.tools ?? [];
    }

    private emit(event: unknown): void {
      for (const listener of this.listeners) listener(event);
    }
  }

  return {
    AuthStorage: MockAuthStorage,
    ModelRegistry: MockModelRegistry,
    SessionManager: { inMemory: vi.fn(() => ({})) },
    DefaultResourceLoader: class {
      constructor(readonly opts: unknown) {}
      async reload() {}
      getSkills() { return { skills: [], diagnostics: [] }; }
    },
    createSyntheticSourceInfo: vi.fn((path: string, options: object) => ({ path, ...options })),
    defineTool: vi.fn((tool: MockToolDefinition) => tool),
    createAgentSession: vi.fn(async (opts: MockCreateOptions) => {
      lastCreateOptions = opts;
      return { session: new MockSession() };
    }),
    lastCreateOptions: () => lastCreateOptions,
    reset: () => {
      lastCreateOptions = undefined;
    },
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: sdk.AuthStorage,
  createAgentSession: sdk.createAgentSession,
  defineTool: sdk.defineTool,
  ModelRegistry: sdk.ModelRegistry,
  SessionManager: sdk.SessionManager,
  DefaultResourceLoader: sdk.DefaultResourceLoader,
  createSyntheticSourceInfo: sdk.createSyntheticSourceInfo,
}));

import { createDeploymentControlPlaneApp } from "./helpers.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";

describe("deployment custom tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.reset();
  });

  it("exposes persisted agent custom tools to the Pi session", async () => {
    const app = createDeploymentControlPlaneApp({
      OMA_SANDBOX_PROVIDER: "none",
    });
    const agent = await createAgent(app);
    const environment = await createEnvironment(app);
    const session = await createSession(app, {
      agent: agent.id,
      environment_id: environment.id,
    });

    await sendMessage(app, session.id, "hello");

    expect(sdk.lastCreateOptions()).toMatchObject({
      noTools: "builtin",
      tools: ["get_recent_deploys"],
    });
    expect(sdk.lastCreateOptions()?.customTools?.map((tool) => tool.name)).toEqual([
      "get_recent_deploys",
    ]);
  });

  it("keeps custom tools available for active sessions after the agent is archived", async () => {
    const app = createDeploymentControlPlaneApp({
      OMA_SANDBOX_PROVIDER: "none",
    });
    const agent = await createAgent(app);
    const environment = await createEnvironment(app);
    const session = await createSession(app, {
      agent: agent.id,
      environment_id: environment.id,
    });

    await archiveAgent(app, agent.id);
    await sendMessage(app, session.id, "hello after archive");

    expect(sdk.lastCreateOptions()).toMatchObject({
      noTools: "builtin",
      tools: ["get_recent_deploys"],
    });
    expect(sdk.lastCreateOptions()?.customTools?.map((tool) => tool.name)).toEqual([
      "get_recent_deploys",
    ]);
  });
});

async function createAgent(
  app: ReturnType<typeof createDeploymentControlPlaneApp>,
): Promise<ManagedAgentsAgent> {
  const res = await app.request("/v1/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Deployment Custom Tool Agent",
      model: "claude-sonnet-4-6",
      tools: [
        {
          type: "custom",
          name: "get_recent_deploys",
          description: "Deploys last 6h.",
          input_schema: { type: "object", properties: {} },
        },
      ],
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsAgent;
}

async function createEnvironment(
  app: ReturnType<typeof createDeploymentControlPlaneApp>,
): Promise<ManagedAgentsEnvironment> {
  const res = await app.request("/v1/environments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Deployment Custom Tool Environment",
      config: { type: "cloud" },
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsEnvironment;
}

async function createSession(
  app: ReturnType<typeof createDeploymentControlPlaneApp>,
  body: unknown,
): Promise<ManagedAgentsSession> {
  const res = await app.request("/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsSession;
}

async function archiveAgent(
  app: ReturnType<typeof createDeploymentControlPlaneApp>,
  agentId: string,
): Promise<void> {
  const res = await app.request(`/v1/agents/${agentId}/archive`, {
    method: "POST",
  });
  expect(res.status).toBe(200);
}

async function sendMessage(
  app: ReturnType<typeof createDeploymentControlPlaneApp>,
  sessionId: string,
  text: string,
): Promise<void> {
  const res = await app.request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    }),
  });
  expect(res.status).toBe(200);
}
