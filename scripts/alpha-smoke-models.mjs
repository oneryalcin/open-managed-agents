export const DEFAULT_ALPHA_MODEL_PROVIDER = "anthropic";
export const DEFAULT_ALPHA_MODEL = "claude-sonnet-5";
export const LOCAL_ALPHA_MODEL_PROVIDER = "oma-local";
export const LOCAL_ALPHA_MODEL = "oma-smoke-model";
export const LOCAL_ALPHA_API_KEY = "oma-local-keyless";

export function resolveAlphaModel(env = process.env, localCompatible = false) {
  if (localCompatible) {
    return {
      provider: LOCAL_ALPHA_MODEL_PROVIDER,
      id: LOCAL_ALPHA_MODEL,
      input: { provider: LOCAL_ALPHA_MODEL_PROVIDER, id: LOCAL_ALPHA_MODEL },
      explicitProvider: true,
    };
  }

  const rawProvider = env.OMA_ALPHA_MODEL_PROVIDER;
  const provider = requiredNonEmpty(rawProvider, DEFAULT_ALPHA_MODEL_PROVIDER, "OMA_ALPHA_MODEL_PROVIDER");
  const id = requiredNonEmpty(env.OMA_ALPHA_MODEL, DEFAULT_ALPHA_MODEL, "OMA_ALPHA_MODEL");
  return {
    provider,
    id,
    // Preserve the existing CMA-compatible string path when the provider is
    // omitted. Once an operator names a provider, prove the explicit pair.
    input: rawProvider === undefined ? id : { provider, id },
    explicitProvider: rawProvider !== undefined,
  };
}

export function createLocalCompatibleModelsConfig(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1")) {
    throw new Error("The alpha compatible-provider fixture must use a loopback HTTP URL");
  }
  return {
    providers: {
      [LOCAL_ALPHA_MODEL_PROVIDER]: {
        name: "OMA local compatible fixture",
        baseUrl: `${baseUrl.replace(/\/+$/, "")}/v1`,
        api: "openai-completions",
        apiKey: LOCAL_ALPHA_API_KEY,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
        models: [{
          id: LOCAL_ALPHA_MODEL,
          name: "OMA deterministic smoke model",
          reasoning: false,
          input: ["text"],
          contextWindow: 16_384,
          maxTokens: 2_048,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  };
}

export const LIVE_PROVIDER_SMOKE_LANES = Object.freeze([
  {
    provider: "anthropic",
    credentialEnv: "ANTHROPIC_API_KEY",
    modelEnv: "OMA_ALPHA_ANTHROPIC_MODEL",
    defaultModel: "claude-haiku-4-5",
  },
  {
    provider: "openai",
    credentialEnv: "OPENAI_API_KEY",
    modelEnv: "OMA_ALPHA_OPENAI_MODEL",
    defaultModel: "gpt-4.1-mini",
  },
  {
    provider: "google",
    credentialEnv: "GEMINI_API_KEY",
    modelEnv: "OMA_ALPHA_GOOGLE_MODEL",
    defaultModel: "gemini-2.5-flash",
  },
  {
    provider: "openrouter",
    credentialEnv: "OPENROUTER_API_KEY",
    modelEnv: "OMA_ALPHA_OPENROUTER_MODEL",
    defaultModel: "openai/gpt-4o-mini",
  },
]);

function requiredNonEmpty(value, fallback, label) {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} must not be empty`);
  return trimmed;
}
