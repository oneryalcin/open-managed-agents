import { describe, expect, it } from "vitest";
import { SqliteAgentStore } from "../../agents/store.ts";
import { DefaultAgentService } from "../../agents/service.ts";
import { SqliteEnvironmentStore } from "../../environments/store.ts";
import { DefaultEnvironmentService } from "../../environments/service.ts";
import { DEFAULT_WORKSPACE_ID } from "../../workspace.ts";
import { DefaultSessionService } from "../service.ts";
import { SqliteSessionStore } from "../store.ts";

const OTHER_WORKSPACE_ID = "wrk_other";

describe("session service/store", () => {
  it("keeps workspace rows isolated and does not leak workspace_id to wire responses", () => {
    const fixture = createFixture();
    const firstAgent = fixture.createAgent(DEFAULT_WORKSPACE_ID, "Default Agent");
    const firstEnv = fixture.createEnvironment(DEFAULT_WORKSPACE_ID, "Default Env");
    const secondAgent = fixture.createAgent(OTHER_WORKSPACE_ID, "Other Agent");
    const secondEnv = fixture.createEnvironment(OTHER_WORKSPACE_ID, "Other Env");

    const first = fixture.sessions.create(DEFAULT_WORKSPACE_ID, {
      agent: firstAgent.id,
      environment_id: firstEnv.id,
    });
    const second = fixture.sessions.create(OTHER_WORKSPACE_ID, {
      agent: secondAgent.id,
      environment_id: secondEnv.id,
    });

    expect(first).not.toHaveProperty("workspace_id");
    expect(second).not.toHaveProperty("workspace_id");
    expect(fixture.sessions.list(DEFAULT_WORKSPACE_ID).data.map((s) => s.id)).toEqual([
      first.id,
    ]);
    expect(fixture.sessions.list(OTHER_WORKSPACE_ID).data.map((s) => s.id)).toEqual([
      second.id,
    ]);
  });

  it("treats an empty page cursor as an invalid direct store cursor", () => {
    const fixture = createFixture();
    const agent = fixture.createAgent(DEFAULT_WORKSPACE_ID, "Default Agent");
    const environment = fixture.createEnvironment(DEFAULT_WORKSPACE_ID, "Default Env");

    fixture.sessions.create(DEFAULT_WORKSPACE_ID, {
      agent: agent.id,
      environment_id: environment.id,
    });

    expect(fixture.sessionStore.list(DEFAULT_WORKSPACE_ID, { page: "" })).toEqual({
      data: [],
      has_more: false,
      next_page: null,
    });
  });

  it("archives sessions as terminated while keeping them retrievable by direct lookup", () => {
    const fixture = createFixture();
    const agent = fixture.createAgent(DEFAULT_WORKSPACE_ID, "Default Agent");
    const environment = fixture.createEnvironment(DEFAULT_WORKSPACE_ID, "Default Env");
    const session = fixture.sessions.create(DEFAULT_WORKSPACE_ID, {
      agent: agent.id,
      environment_id: environment.id,
    });

    const archived = fixture.sessions.archive(DEFAULT_WORKSPACE_ID, session.id);

    expect(archived.id).toBe(session.id);
    expect(archived.status).toBe("terminated");
    expect(archived.archived_at).toEqual(expect.any(String));
    expect(fixture.sessions.retrieve(DEFAULT_WORKSPACE_ID, session.id).id).toBe(
      session.id,
    );
    expect(fixture.sessions.list(DEFAULT_WORKSPACE_ID).data).toEqual([]);
    expect(
      fixture.sessions.list(DEFAULT_WORKSPACE_ID, { includeArchived: true }).data
        .map((s) => s.id),
    ).toEqual([session.id]);
  });

  it("permanently deletes sessions", () => {
    const fixture = createFixture();
    const agent = fixture.createAgent(DEFAULT_WORKSPACE_ID, "Default Agent");
    const environment = fixture.createEnvironment(DEFAULT_WORKSPACE_ID, "Default Env");
    const session = fixture.sessions.create(DEFAULT_WORKSPACE_ID, {
      agent: agent.id,
      environment_id: environment.id,
    });

    expect(fixture.sessions.delete(DEFAULT_WORKSPACE_ID, session.id)).toEqual({
      id: session.id,
      type: "session_deleted",
    });
    expect(() => fixture.sessions.retrieve(DEFAULT_WORKSPACE_ID, session.id))
      .toThrow("Session");
    expect(
      fixture.sessions.list(DEFAULT_WORKSPACE_ID, { includeArchived: true }).data,
    ).toEqual([]);
  });
});

function createFixture(): {
  sessions: DefaultSessionService;
  sessionStore: SqliteSessionStore;
  createAgent(workspaceId: string, name: string): { id: string };
  createEnvironment(workspaceId: string, name: string): { id: string };
} {
  const agentStore = SqliteAgentStore.open(":memory:");
  const environmentStore = SqliteEnvironmentStore.open(":memory:");
  const sessionStore = SqliteSessionStore.open(":memory:");
  const agents = new DefaultAgentService(agentStore);
  const environments = new DefaultEnvironmentService(environmentStore);
  const sessions = new DefaultSessionService(
    sessionStore,
    agentStore,
    environmentStore,
  );

  return {
    sessions,
    sessionStore,
    createAgent(workspaceId: string, name: string): { id: string } {
      return agents.create(workspaceId, {
        name,
        model: "claude-opus-4-7",
        tools: [{ type: "agent_toolset_20260401" }],
      });
    },
    createEnvironment(workspaceId: string, name: string): { id: string } {
      return environments.create(workspaceId, {
        name,
        config: { type: "cloud" },
      });
    },
  };
}
