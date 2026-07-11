import { describe, expect, it } from "vitest";
import { SqliteAgentStore } from "../store.ts";
import { DefaultAgentService } from "../service.ts";

const REQUEST = {
  name: "Scoped Agent",
  model: "claude-opus-4-7",
  tools: [{ type: "agent_toolset_20260401" }],
};

describe("AgentService + AgentStore", () => {
  it("scopes agents by workspace internally", () => {
    const store = SqliteAgentStore.open(":memory:");
    const service = new DefaultAgentService(store);

    const agent = service.create("wrk_a", REQUEST);

    expect(service.retrieve("wrk_a", agent.id).id).toBe(agent.id);
    expect(store.retrieveAny("wrk_a", agent.id)?.id).toBe(agent.id);
    expect(() => service.retrieve("wrk_b", agent.id)).toThrow(
      `Agent ${agent.id} not found`,
    );
  });

  it("archives agents idempotently while preserving direct lookup", () => {
    const store = SqliteAgentStore.open(":memory:");
    const service = new DefaultAgentService(store);
    const agent = service.create("wrk_default", REQUEST);

    const archived = service.archive("wrk_default", agent.id);

    expect(archived.id).toBe(agent.id);
    expect(archived.archived_at).toEqual(expect.any(String));
    expect(store.retrieve("wrk_default", agent.id)).toBeUndefined();
    expect(service.retrieve("wrk_default", agent.id)).toEqual(archived);
    expect(service.list("wrk_default")).toEqual({
      data: [],
      has_more: false,
      next_page: null,
    });
    expect(service.list("wrk_default", { includeArchived: true })).toEqual({
      data: [archived],
      has_more: false,
      next_page: null,
    });

    const archivedAgain = service.archive("wrk_default", agent.id);
    expect(archivedAgain.archived_at).toBe(archived.archived_at);
    expect(archivedAgain.updated_at).toBe(archived.updated_at);
  });

  it("does not leak archived agents across workspaces", () => {
    const store = SqliteAgentStore.open(":memory:");
    const service = new DefaultAgentService(store);
    const agent = service.create("wrk_a", REQUEST);

    expect(() => service.archive("wrk_b", agent.id)).toThrow(
      `Agent ${agent.id} not found`,
    );
    expect(service.retrieve("wrk_a", agent.id).archived_at).toBe(null);
    expect(store.retrieveAny("wrk_b", agent.id)).toBeUndefined();
  });

  it("paginates list results by opaque next_page cursor", () => {
    const store = SqliteAgentStore.open(":memory:");
    const service = new DefaultAgentService(store);
    const first = service.create("wrk_default", {
      ...REQUEST,
      name: "First",
    });
    const second = service.create("wrk_default", {
      ...REQUEST,
      name: "Second",
    });

    const page1 = service.list("wrk_default", { limit: 1 });
    expect(page1).toEqual({
      data: [first],
      has_more: true,
      next_page: first.id,
    });

    const page2 = service.list("wrk_default", {
      limit: 1,
      page: page1.next_page ?? undefined,
    });
    expect(page2).toEqual({
      data: [second],
      has_more: false,
      next_page: null,
    });
  });

  it("does not treat an empty cursor as a valid store page", () => {
    const store = SqliteAgentStore.open(":memory:");
    const service = new DefaultAgentService(store);
    service.create("wrk_default", REQUEST);

    expect(store.list("wrk_default", { page: "" })).toEqual({
      data: [],
      has_more: false,
      next_page: null,
    });
  });

  it("scopes list results by workspace internally", () => {
    const store = SqliteAgentStore.open(":memory:");
    const service = new DefaultAgentService(store);
    const agentA = service.create("wrk_a", REQUEST);
    service.create("wrk_b", { ...REQUEST, name: "Other Workspace" });

    expect(service.list("wrk_a")).toEqual({
      data: [agentA],
      has_more: false,
      next_page: null,
    });
  });

  it("accepts exactly twenty distinct skill attachments", () => {
    const store = SqliteAgentStore.open(":memory:");
    const service = new DefaultAgentService(store, {
      getSkill: (_workspaceId, skillId) => ({
        id: skillId,
        display_title: skillId,
        latest_version: "1",
        source: "custom",
        type: "skill",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
      getVersion: (_workspaceId, skillId, version) => ({
        id: `skill_version_${skillId}`,
        skill_id: skillId,
        version,
        name: skillId,
        description: "test",
        directory: skillId,
        type: "skill_version",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    });
    const skills = Array.from({ length: 20 }, (_, index) => ({
      type: "custom" as const,
      skill_id: `skill_${index}`,
    }));
    expect(service.create("wrk_default", { ...REQUEST, skills }).skills).toEqual(skills);
  });
});
