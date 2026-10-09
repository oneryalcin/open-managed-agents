import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryAuthStorageBackend,
  InMemoryModelsStore,
  OmaCredentialStore,
} from "../../../models/credential-store.ts";
import type { PiModelCatalog } from "../../../models/catalog.ts";
import type { PiConversationSeed, PiRuntimeSession } from "../runner.ts";

// Real Pi sessions driven by Pi's own faux model provider, for tests that
// depend on Pi's actual behaviour (session entries, settlement, compaction)
// rather than a fake's. No network.
//
// The faux provider lives in @earendil-works/pi-ai, which OMA does not depend
// on directly. Import the copy the installed pi-coding-agent itself uses
// (nested under it, or hoisted), so tests always match the Pi OMA runs.
function piAiEntry(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const piDir = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    if (existsSync(join(piDir, "package.json"))) {
      for (const candidate of [
        join(piDir, "node_modules", "@earendil-works", "pi-ai"),
        join(dir, "node_modules", "@earendil-works", "pi-ai"),
      ]) {
        const entry = join(candidate, "dist", "index.js");
        if (existsSync(entry)) return entry;
      }
      throw new Error("pi-ai not found next to pi-coding-agent");
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("pi-coding-agent not found");
    dir = parent;
  }
}

type FauxModule = {
  createFauxCore(options: { provider: string; models: Array<{ id: string }> }): {
    api: string;
    streamSimple: unknown;
    state: { callCount: number };
    setResponses(responses: unknown[]): void;
    appendResponses(responses: unknown[]): void;
  };
  fauxAssistantMessage(content: unknown, options?: { stopReason?: string }): unknown;
  fauxToolCall(name: string, args: Record<string, unknown>): unknown;
};

export async function loadFaux(): Promise<FauxModule> {
  return (await import(pathToFileURL(piAiEntry()).href)) as FauxModule;
}

export interface RealPi {
  faux: FauxModule;
  core: ReturnType<FauxModule["createFauxCore"]>;
  /** User-visible text of every model request's messages, in call order. */
  requests: string[][];
  /** Counts sessions created, so tests can tell a rebuild happened. */
  created: { count: number };
  sessionFactory: (
    workspaceId: string,
    sessionId: string,
    seed: PiConversationSeed,
  ) => Promise<PiRuntimeSession>;
  /**
   * A model catalog serving only the faux model, for tests that need the
   * runner's real session build (tools registered with Pi), not a factory.
   */
  modelCatalog: PiModelCatalog;
}

export async function createRealPi(): Promise<RealPi> {
  const faux = await loadFaux();
  const core = faux.createFauxCore({ provider: "faux", models: [{ id: "m" }] });
  const runtime = await ModelRuntime.create({
    credentials: new OmaCredentialStore(
      new InMemoryAuthStorageBackend({ faux: { type: "api_key", key: "x" } }),
    ),
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
  });
  const requests: string[][] = [];
  type Context = { messages: Array<{ role: string; content: unknown }> };
  const streamSimple = core.streamSimple as (
    model: unknown,
    context: Context,
    options?: unknown,
  ) => unknown;
  runtime.registerProvider("faux", {
    api: core.api,
    baseUrl: "http://faux.invalid",
    apiKey: "x",
    streamSimple: ((model: unknown, context: Context, options?: unknown) => {
      requests.push(
        context.messages.map((message) => `${message.role}:${textOf(message.content)}`),
      );
      return streamSimple(model, context, options);
    }) as never,
    models: [
      {
        id: "m",
        name: "m",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 1_000,
      },
    ],
  });
  const model = runtime.getModel("faux", "m");
  if (!model) throw new Error("faux model not registered");
  const created = { count: 0 };
  const modelCatalog = {
    defaultModel: { provider: "faux", id: "m" },
    allowedProviders: new Set(["faux"]),
    modelRuntime: runtime,
    assertConfigSecurity: () => {},
    resolve: () => model,
    list: () => [model],
    hasConfiguredAuth: () => true,
    providerAuthMetadata: () => ({}),
  } as unknown as PiModelCatalog;
  return {
    modelCatalog,
    faux,
    core,
    requests,
    created,
    sessionFactory: async (_workspaceId, _sessionId, seed) => {
      created.count += 1;
      const { session } = await createAgentSession({
        model,
        modelRuntime: runtime,
        noTools: "all",
        thinkingLevel: "off",
        sessionManager: seed.length === 0
          ? SessionManager.inMemory()
          : SessionManager.inMemory(undefined, undefined, seed),
      });
      return session as unknown as PiRuntimeSession;
    },
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "object" && block !== null && "text" in block
        ? String((block as { text: unknown }).text)
        : "",
    )
    .join("");
}
