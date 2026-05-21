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
    expect(() => service.retrieve("wrk_b", agent.id)).toThrow(
      `Agent ${agent.id} not found`,
    );
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
});
