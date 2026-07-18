import { describe, expect, it } from "vitest";
import { startAlphaOpenAICompatibleFixture } from "../alpha-openai-compatible-fixture.mjs";
import {
  LOCAL_ALPHA_API_KEY,
  LOCAL_ALPHA_MODEL,
  createLocalCompatibleModelsConfig,
  resolveAlphaModel,
} from "../alpha-smoke-models.mjs";

describe("alpha provider smoke configuration", () => {
  it("preserves the CMA string default and uses an explicit pair when provider is named", () => {
    expect(resolveAlphaModel({})).toMatchObject({
      provider: "anthropic",
      id: "claude-sonnet-5",
      input: "claude-sonnet-5",
      explicitProvider: false,
    });
    expect(resolveAlphaModel({ OMA_ALPHA_MODEL_PROVIDER: "openai", OMA_ALPHA_MODEL: "gpt-4.1-mini" })).toMatchObject({
      provider: "openai",
      id: "gpt-4.1-mini",
      input: { provider: "openai", id: "gpt-4.1-mini" },
      explicitProvider: true,
    });
  });

  it("builds a loopback-only, keyless-placeholder custom provider config", () => {
    const config = createLocalCompatibleModelsConfig("http://127.0.0.1:4321");
    expect(config.providers["oma-local"]).toMatchObject({
      baseUrl: "http://127.0.0.1:4321/v1",
      api: "openai-completions",
      apiKey: LOCAL_ALPHA_API_KEY,
      models: [{ id: LOCAL_ALPHA_MODEL }],
    });
    expect(() => createLocalCompatibleModelsConfig("https://example.com")).toThrow(/loopback HTTP/);
  });

  it("serves the two-turn OpenAI-compatible tool round trip", async () => {
    const fixture = await startAlphaOpenAICompatibleFixture({
      apiKey: LOCAL_ALPHA_API_KEY,
      modelId: LOCAL_ALPHA_MODEL,
      token: "OMA_ALPHA_SMOKE_OK",
    });
    try {
      const first = await completion(fixture.baseUrl, {
        model: LOCAL_ALPHA_MODEL,
        stream: true,
        messages: [{ role: "user", content: "run it" }],
        tools: [{ type: "function", function: { name: "bash", parameters: {} } }],
      });
      expect(first).toContain("call_oma_alpha_smoke");
      const second = await completion(fixture.baseUrl, {
        model: LOCAL_ALPHA_MODEL,
        stream: true,
        messages: [{ role: "tool", content: "OMA_ALPHA_SMOKE_OK", tool_call_id: "call_oma_alpha_smoke" }],
      });
      expect(second).toContain("OMA_ALPHA_SMOKE_OK");
      expect(() => fixture.assertComplete()).not.toThrow();
    } finally {
      await fixture.close();
    }
  });
});

async function completion(baseUrl, body) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${LOCAL_ALPHA_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.text();
}
