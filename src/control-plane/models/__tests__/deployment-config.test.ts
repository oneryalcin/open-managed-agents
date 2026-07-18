import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_PROVIDER,
  MODEL_DEPLOYMENT_ENV_KEYS,
  parseModelDeploymentConfigFromEnv,
  validateModelDeploymentConfigAgainstCatalog,
  type ModelDeploymentCatalog,
} from "../deployment-config.ts";

describe("model deployment config", () => {
  it("uses the alpha Anthropic defaults and OMA-owned Pi paths", () => {
    const config = parseModelDeploymentConfigFromEnv({}, { home: "/tmp/oma-home" });

    expect(config).toEqual({
      allowedProviders: [DEFAULT_MODEL_PROVIDER],
      defaultModel: {
        provider: DEFAULT_MODEL_PROVIDER,
        id: DEFAULT_MODEL_ID,
      },
      authPath: resolve("/tmp/oma-home/pi/auth.json"),
      modelsPath: resolve("/tmp/oma-home/pi/models.json"),
      allowModelAuthCommands: false,
    });
  });

  it("exports the complete D4 env vocabulary", () => {
    expect(MODEL_DEPLOYMENT_ENV_KEYS).toEqual([
      "OMA_HOME",
      "OMA_MODEL_PROVIDERS",
      "OMA_DEFAULT_MODEL_PROVIDER",
      "OMA_DEFAULT_MODEL",
      "OMA_PI_AUTH_FILE",
      "OMA_PI_MODELS_FILE",
      "OMA_ALLOW_MODEL_AUTH_COMMANDS",
    ]);
  });

  it("trims values once while preserving deterministic case-sensitive provider IDs", () => {
    const config = parseModelDeploymentConfigFromEnv(
      {
        OMA_MODEL_PROVIDERS: " anthropic,openai,OpenAI ",
        OMA_DEFAULT_MODEL_PROVIDER: " openai ",
        OMA_DEFAULT_MODEL: " gpt-5 ",
        OMA_ALLOW_MODEL_AUTH_COMMANDS: " true ",
      },
      { home: "/tmp/unused" },
    );

    expect(config.allowedProviders).toEqual(["anthropic", "openai", "OpenAI"]);
    expect(config.defaultModel).toEqual({ provider: "openai", id: "gpt-5" });
    expect(config.allowModelAuthCommands).toBe(true);
  });

  it("rejects empty and duplicate provider entries", () => {
    expect(() =>
      parseModelDeploymentConfigFromEnv({ OMA_MODEL_PROVIDERS: " " }),
    ).toThrow("OMA_MODEL_PROVIDERS must not be empty");
    expect(() =>
      parseModelDeploymentConfigFromEnv({ OMA_MODEL_PROVIDERS: "anthropic,,openai" }),
    ).toThrow("OMA_MODEL_PROVIDERS must be comma-separated provider names");
    expect(() =>
      parseModelDeploymentConfigFromEnv({ OMA_MODEL_PROVIDERS: "anthropic, anthropic" }),
    ).toThrow("Duplicate model provider in OMA_MODEL_PROVIDERS: anthropic");
  });

  it("requires default provider and model to be set together", () => {
    expect(() =>
      parseModelDeploymentConfigFromEnv({ OMA_DEFAULT_MODEL_PROVIDER: " " }),
    ).toThrow("OMA_DEFAULT_MODEL_PROVIDER must not be empty");
    expect(() =>
      parseModelDeploymentConfigFromEnv({ OMA_DEFAULT_MODEL: " " }),
    ).toThrow("OMA_DEFAULT_MODEL must not be empty");
    expect(() =>
      parseModelDeploymentConfigFromEnv({ OMA_DEFAULT_MODEL_PROVIDER: "openai" }),
    ).toThrow("OMA_DEFAULT_MODEL_PROVIDER and OMA_DEFAULT_MODEL must be set together");
    expect(() =>
      parseModelDeploymentConfigFromEnv({ OMA_DEFAULT_MODEL: "gpt-5" }),
    ).toThrow("OMA_DEFAULT_MODEL_PROVIDER and OMA_DEFAULT_MODEL must be set together");
  });

  it("requires the configured default provider to be allowlisted", () => {
    expect(() =>
      parseModelDeploymentConfigFromEnv({
        OMA_MODEL_PROVIDERS: "anthropic",
        OMA_DEFAULT_MODEL_PROVIDER: "openai",
        OMA_DEFAULT_MODEL: "gpt-5",
      }),
    ).toThrow("OMA_DEFAULT_MODEL_PROVIDER openai must be listed in OMA_MODEL_PROVIDERS");
  });

  it("resolves explicit auth and models paths without leaking contents", () => {
    const config = parseModelDeploymentConfigFromEnv(
      {
        OMA_HOME: " /tmp/oma-home ",
        OMA_PI_AUTH_FILE: " ./operator-auth.json ",
        OMA_PI_MODELS_FILE: " ../operator-models.json ",
      },
      { home: "/tmp/ignored" },
    );

    expect(config.authPath).toBe(resolve("./operator-auth.json"));
    expect(config.modelsPath).toBe(resolve("../operator-models.json"));
    expect(() =>
      parseModelDeploymentConfigFromEnv({ OMA_PI_AUTH_FILE: " " }),
    ).toThrow("OMA_PI_AUTH_FILE must not be empty");
    expect(() =>
      parseModelDeploymentConfigFromEnv({ OMA_PI_MODELS_FILE: " " }),
    ).toThrow("OMA_PI_MODELS_FILE must not be empty");
    expect(() =>
      parseModelDeploymentConfigFromEnv({ OMA_HOME: " " }),
    ).toThrow("OMA_HOME must not be empty");
  });

  it("rejects malformed command opt-in values", () => {
    expect(() =>
      parseModelDeploymentConfigFromEnv({ OMA_ALLOW_MODEL_AUTH_COMMANDS: " " }),
    ).toThrow("OMA_ALLOW_MODEL_AUTH_COMMANDS must not be empty");
    expect(() =>
      parseModelDeploymentConfigFromEnv({ OMA_ALLOW_MODEL_AUTH_COMMANDS: "yes" }),
    ).toThrow('OMA_ALLOW_MODEL_AUTH_COMMANDS must be "true" or "false"');
  });

  it("validates allowlisted providers and the default pair against the loaded catalog", () => {
    const catalog = fakeCatalog([
      ["anthropic", "claude-sonnet-5"],
      ["openai", "gpt-5"],
    ]);
    const config = parseModelDeploymentConfigFromEnv({
      OMA_MODEL_PROVIDERS: "anthropic,openai",
      OMA_DEFAULT_MODEL_PROVIDER: "openai",
      OMA_DEFAULT_MODEL: "gpt-5",
    });

    expect(validateModelDeploymentConfigAgainstCatalog(config, catalog)).toBe(config);
  });

  it("fails startup validation for unknown providers and unresolved defaults", () => {
    expect(() =>
      validateModelDeploymentConfigAgainstCatalog(
        parseModelDeploymentConfigFromEnv({
          OMA_MODEL_PROVIDERS: "anthropic,openai",
        }),
        fakeCatalog([["anthropic", "claude-sonnet-5"]]),
      ),
    ).toThrow("Model provider openai is not available on this deployment");

    expect(() =>
      validateModelDeploymentConfigAgainstCatalog(
        parseModelDeploymentConfigFromEnv({
          OMA_MODEL_PROVIDERS: "anthropic",
          OMA_DEFAULT_MODEL_PROVIDER: "anthropic",
          OMA_DEFAULT_MODEL: "missing-model",
        }),
        fakeCatalog([["anthropic", "claude-sonnet-5"]]),
      ),
    ).toThrow("Default model anthropic/missing-model is not available on this deployment");
  });
});

function fakeCatalog(entries: Array<[string, string]>): ModelDeploymentCatalog {
  const providers = new Set(entries.map(([provider]) => provider));
  const models = new Set(entries.map(([provider, id]) => `${provider}/${id}`));
  return {
    hasProvider: (provider) => providers.has(provider),
    hasModel: (model) => models.has(`${model.provider}/${model.id}`),
  };
}
