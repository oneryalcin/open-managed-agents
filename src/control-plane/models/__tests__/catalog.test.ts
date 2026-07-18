import {
  InMemoryAuthStorageBackend,
  type AuthStorageBackend,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPiModelCatalog } from "../catalog.ts";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "oma-model-catalog-"));
  roots.push(root);
  return root;
}

function writeModelsJson(root: string, content: string): string {
  const path = join(root, "models.json");
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

function createTestCatalog(options: {
  providers?: readonly string[];
  defaultModel?: { provider: string; id: string };
  modelsPath?: string;
  authBackend?: AuthStorageBackend;
} = {}) {
  return createPiModelCatalog({
    allowedProviders: options.providers ?? ["anthropic"],
    defaultModel: options.defaultModel ?? { provider: "anthropic", id: "claude-sonnet-5" },
    authBackend: options.authBackend ?? new InMemoryAuthStorageBackend(),
    modelsPath: options.modelsPath,
  });
}

describe("createPiModelCatalog", () => {
  it("resolves and lists only exact allowed provider/model pairs", () => {
    const catalog = createTestCatalog({ providers: ["anthropic", "openai"] });

    expect(catalog.resolve({ provider: "anthropic", id: "claude-sonnet-5" })?.id).toBe("claude-sonnet-5");
    expect(catalog.resolve({ provider: "Anthropic", id: "claude-sonnet-5" })).toBeUndefined();
    expect(catalog.resolve({ provider: "google", id: "gemini-2.5-pro" })).toBeUndefined();
    expect(catalog.list({ provider: "openai" }).every((model) => model.provider === "openai")).toBe(true);
    expect(catalog.list().every((model) => catalog.allowedProviders.has(model.provider))).toBe(true);
  });

  it("uses model-scoped configured-auth readiness", () => {
    const backend = new InMemoryAuthStorageBackend();
    backend.withLock(() => ({
      result: undefined,
      next: JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }),
    }));
    const catalog = createTestCatalog({ providers: ["anthropic", "openai"], authBackend: backend });
    const openaiModel = catalog.resolve({ provider: "openai", id: "gpt-5" });

    expect(openaiModel).toBeDefined();
    expect(catalog.hasConfiguredAuth(openaiModel!)).toBe(true);
  });

  it("recognizes environment credentials through model-scoped readiness", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-environment-test");
    const catalog = createTestCatalog({ providers: ["anthropic", "openai"] });
    const openaiModel = catalog.resolve({ provider: "openai", id: "gpt-5" });

    expect(openaiModel).toBeDefined();
    expect(catalog.hasConfiguredAuth(openaiModel!)).toBe(true);
  });

  it("fails startup when auth storage cannot be parsed", () => {
    const backend = new InMemoryAuthStorageBackend();
    backend.withLock(() => ({ result: undefined, next: "not-json" }));

    expect(() => createTestCatalog({ authBackend: backend })).toThrow(/Failed to load model auth storage/);
  });

  it("fails startup when Pi reports malformed models.json", () => {
    const root = tempRoot();
    const modelsPath = writeModelsJson(root, `{"providers":{"local":{"baseUrl":"http://localhost:11434","api":"openai-responses","models":[{"id":"local","input":["audio"]}]}}}`);

    expect(() =>
      createTestCatalog({
        providers: ["anthropic", "local"],
        modelsPath,
      }),
    ).toThrow(/Invalid models\.json schema/);
  });

  it("fails startup for unknown allowed providers and unavailable defaults", () => {
    expect(() => createTestCatalog({ providers: ["anthropic", "missing"] })).toThrow(/missing.*not available/);
    expect(() =>
      createTestCatalog({ defaultModel: { provider: "anthropic", id: "missing-model" } }),
    ).toThrow(/Default model anthropic\/missing-model is not available/);
  });
});
