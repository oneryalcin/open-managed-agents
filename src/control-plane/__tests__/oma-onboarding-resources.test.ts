import { describe, expect, it } from "vitest";
import { ensureStarterResources } from "../../../scripts/oma-onboarding-resources.ts";

describe("onboarding starter resources", () => {
  it("creates the marked starter graph once and reuses it on rerun", async () => {
    const api = new StarterApi();
    const first = await ensureStarterResources({
      baseUrl: "http://127.0.0.1:4180",
      workspaceKey: "oma_test",
      provider: "openai",
      fetch: api.fetch,
    });
    const second = await ensureStarterResources({
      baseUrl: "http://127.0.0.1:4180",
      workspaceKey: "oma_test",
      provider: "openai",
      fetch: api.fetch,
    });

    expect(first.created).toEqual(["agent", "environment", "session"]);
    expect(second.created).toEqual([]);
    expect(second).toMatchObject({
      agentId: first.agentId,
      environmentId: first.environmentId,
      sessionId: first.sessionId,
    });
    expect(api.posts).toEqual({ agents: 1, environments: 1, sessions: 1 });
  });

  it("does not reuse an archived marked graph", async () => {
    const api = new StarterApi();
    await ensureStarterResources({ baseUrl: "http://127.0.0.1:4180", workspaceKey: "oma_test", provider: "openai", fetch: api.fetch });
    api.archiveAll();
    const replacement = await ensureStarterResources({ baseUrl: "http://127.0.0.1:4180", workspaceKey: "oma_test", provider: "openai", fetch: api.fetch });

    expect(replacement.created).toEqual(["agent", "environment", "session"]);
    expect(replacement.warnings).toHaveLength(3);
    expect(api.posts).toEqual({ agents: 2, environments: 2, sessions: 2 });
  });
});

class StarterApi {
  readonly posts = { agents: 0, environments: 0, sessions: 0 };
  private readonly agents: Array<Record<string, unknown>> = [];
  private readonly environments: Array<Record<string, unknown>> = [];
  private readonly sessions: Array<Record<string, unknown>> = [];

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method === "GET" && url.pathname === "/v1/model-catalog") {
      return json({ data: [{ provider: "openai", id: "gpt-5", default: true }], has_more: false, next_page: null });
    }
    const collection = url.pathname === "/v1/agents" ? this.agents
      : url.pathname === "/v1/environments" ? this.environments
      : url.pathname === "/v1/sessions" ? this.sessions
      : undefined;
    if (collection === undefined) return json({ error: { message: "not found" } }, 404);
    if (method === "GET") return json({ data: collection, has_more: false, next_page: null });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.pathname === "/v1/agents") {
      this.posts.agents += 1;
      const row = { ...body, id: `agent_${this.posts.agents}`, archived_at: null };
      collection.push(row);
      return json(row);
    }
    if (url.pathname === "/v1/environments") {
      this.posts.environments += 1;
      const row = { ...body, id: `env_${this.posts.environments}`, archived_at: null };
      collection.push(row);
      return json(row);
    }
    this.posts.sessions += 1;
    const row = {
      ...body,
      id: `sess_${this.posts.sessions}`,
      agent: { id: body.agent },
      archived_at: null,
    };
    collection.push(row);
    return json(row);
  };

  archiveAll(): void {
    for (const row of [...this.agents, ...this.environments, ...this.sessions]) row.archived_at = new Date().toISOString();
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
