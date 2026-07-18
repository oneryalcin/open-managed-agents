import { describe, expect, it } from "vitest";
import { DefaultModelCatalogService, type ModelCatalogService } from "../service.ts";
import type { PiModelCatalog, PiResolvedModel } from "../catalog.ts";
import { createRawControlPlaneApp, MANAGED_AGENTS_BETA } from "../../__tests__/helpers.ts";
import { routeClassForPath } from "../../app.ts";

const MODELS = [
  model({ provider: "openai", id: "gpt-a", name: "GPT A", configured: true }),
  model({ provider: "anthropic", id: "claude-b", name: "Claude B", configured: false }),
  model({ provider: "anthropic", id: "claude-a", name: "Claude A", configured: true }),
] as const;

describe("DefaultModelCatalogService", () => {
  it("lists secret-free catalog entries in stable provider/id order", () => {
    const service = new DefaultModelCatalogService(fakeCatalog());

    const page = service.list("wrk_default", { limit: 10 });

    expect(page.next_page).toBeNull();
    expect(page.data.map((item) => `${item.provider}/${item.id}`)).toEqual([
      "anthropic/claude-a",
      "anthropic/claude-b",
      "openai/gpt-a",
    ]);
    expect(page.data[0]).toMatchObject({
      type: "model",
      provider: "anthropic",
      id: "claude-a",
      name: "Claude A",
      provider_name: "Anthropic",
      reasoning: true,
      input: ["text", "image"],
      context_window: 200000,
      max_output_tokens: 64000,
      credentials_configured: true,
      default: true,
    });
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("baseUrl");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("source");
  });

  it("filters by provider and model-scoped readiness", () => {
    const service = new DefaultModelCatalogService(fakeCatalog());

    expect(
      service.list("wrk_default", { provider: "anthropic", available: true }).data
        .map((item) => item.id),
    ).toEqual(["claude-a"]);
  });

  it("uses authenticated cursors bound to workspace and filters", () => {
    const service = new DefaultModelCatalogService(fakeCatalog());
    const first = service.list("wrk_a", { limit: 1, provider: "anthropic" });

    expect(first.next_page).toEqual(expect.any(String));
    expect(
      service.list("wrk_a", {
        limit: 10,
        provider: "anthropic",
        page: first.next_page!,
      }).data.map((item) => item.id),
    ).toEqual(["claude-b"]);
    expect(() =>
      service.list("wrk_b", {
        limit: 10,
        provider: "anthropic",
        page: first.next_page!,
      }),
    ).toThrow("invalid page cursor");
    expect(() =>
      service.list("wrk_a", {
        limit: 10,
        available: true,
        provider: "anthropic",
        page: first.next_page!,
      }),
    ).toThrow("page token filters do not match request");
    expect(() =>
      service.list("wrk_a", {
        limit: 10,
        provider: "anthropic",
        page: tamperCursor(first.next_page!, { provider: null }),
      }),
    ).toThrow("invalid page cursor");
  });

  it("rejects excessive limits", () => {
    const service = new DefaultModelCatalogService(fakeCatalog());

    expect(() => service.list("wrk_default", { limit: 101 })).toThrow(
      "`limit` must be an integer from 1 through 100",
    );
  });
});

describe("model-catalog route", () => {
  it("is workspace-authenticated, beta-gated, and classified as v1", async () => {
    const service = new DefaultModelCatalogService(fakeCatalog());
    const app = makeApp(service);

    expect(routeClassForPath("/v1/model-catalog")).toBe("v1");
    expect((await app.request("/v1/model-catalog")).status).toBe(401);
    expect(
      (await app.request("/v1/model-catalog", {
        headers: { "x-api-key": "key-a" },
      })).status,
    ).toBe(404);
    const ok = await app.request("/v1/model-catalog?available=true&limit=1", {
      headers: { "x-api-key": "key-a", "anthropic-beta": MANAGED_AGENTS_BETA },
    });

    expect(ok.status).toBe(200);
    const body = await ok.json() as { data: Array<{ provider: string; id: string }>; next_page: string | null };
    expect(body.data).toEqual([{ provider: "anthropic", id: "claude-a", type: "model", name: "Claude A", provider_name: "Anthropic", reasoning: true, input: ["text", "image"], context_window: 200000, max_output_tokens: 64000, credentials_configured: true, default: true }]);
    expect(body.next_page).toEqual(expect.any(String));
  });

  it("rejects invalid query values through the HTTP envelope", async () => {
    const app = makeApp(new DefaultModelCatalogService(fakeCatalog()));
    const res = await app.request("/v1/model-catalog?available=yes", {
      headers: { "x-api-key": "key-a", "anthropic-beta": MANAGED_AGENTS_BETA },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { message: "`available` must be `true` or `false`" },
    });
  });
});

function makeApp(models: ModelCatalogService) {
  return createRawControlPlaneApp({
    agents: {} as never,
    environments: {} as never,
    sessions: {} as never,
    sessionEvents: {} as never,
    models,
    auth: {
      authenticate(key: string) {
        if (key === "key-a") return "wrk_a";
        if (key === "key-b") return "wrk_b";
        return undefined;
      },
    },
  });
}

function fakeCatalog(): PiModelCatalog {
  return {
    defaultModel: { provider: "anthropic", id: "claude-a" },
    allowedProviders: new Set(["anthropic", "openai"]),
    authStorage: {} as never,
    modelRegistry: {
      getProviderDisplayName(provider: string) {
        return provider === "anthropic" ? "Anthropic" : "OpenAI";
      },
    } as never,
    securityReport: { warnings: [] },
    resolve: () => undefined,
    list(options = {}) {
      return MODELS
        .filter((item) => options.provider === undefined || item.provider === options.provider)
        .filter((item) => !options.availableOnly || item.configured)
        .map(({ configured: _configured, ...item }) => item as unknown as PiResolvedModel);
    },
    hasConfiguredAuth(model) {
      return MODELS.some((item) =>
        item.provider === model.provider &&
        item.id === model.id &&
        item.configured
      );
    },
    providerAuthMetadata: () => ({}),
  };
}

function model(input: {
  provider: string;
  id: string;
  name: string;
  configured: boolean;
}) {
  return {
    ...input,
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 200000,
    maxTokens: 64000,
  };
}

function tamperCursor(cursor: string, patch: Record<string, unknown>): string {
  const [encodedPayload, signature] = cursor.split(".") as [string, string];
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
  return `${Buffer.from(JSON.stringify({ ...payload, ...patch }), "utf8").toString("base64url")}.${signature}`;
}
