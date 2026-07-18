import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { createInMemoryControlPlaneApp } from "./helpers.ts";

describe("official Anthropic SDK agent response compatibility", () => {
  it("preserves OMA's model.provider extension through create, retrieve, and list", async () => {
    const app = createInMemoryControlPlaneApp();
    const client = new Anthropic({
      apiKey: "sdk-compat-test",
      baseURL: "http://oma.test",
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    });

    const created = await client.beta.agents.create({
      name: "SDK compatibility",
      model: "claude-opus-4-7",
    });
    expect(modelProvider(created.model)).toBe("anthropic");

    const retrieved = await client.beta.agents.retrieve(created.id);
    expect(modelProvider(retrieved.model)).toBe("anthropic");

    const page = await client.beta.agents.list({ limit: 10 });
    expect(page.data.map((agent) => modelProvider(agent.model))).toEqual([
      "anthropic",
    ]);
  });
});

function modelProvider(model: unknown): unknown {
  return (model as { provider?: unknown }).provider;
}
