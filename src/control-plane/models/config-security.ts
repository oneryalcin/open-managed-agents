import {
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { isIP } from "node:net";

export const SUPPORTED_PI_MODEL_APIS = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "mistral-conversations",
  "google-generative-ai",
  "google-vertex",
  "bedrock-converse-stream",
] as const;

export interface ModelConfigSecurityOptions {
  modelsPath?: string;
  authPath?: string;
  allowedProviders: ReadonlySet<string>;
  allowCommands?: boolean;
}

export interface ModelConfigSecurityReport {
  warnings: string[];
}

export function scanModelConfigSecurity(
  options: ModelConfigSecurityOptions,
): ModelConfigSecurityReport {
  const warnings: string[] = [];
  if (options.modelsPath) {
    scanPathSafety(options.modelsPath, "models.json");
    if (existsSync(options.modelsPath)) {
      scanModelsJson(options.modelsPath, options, warnings);
    }
  }
  if (options.authPath) {
    scanPathSafety(options.authPath, "auth.json");
    if (existsSync(options.authPath)) {
      scanAuthJson(options.authPath, options.allowCommands === true);
    }
  }
  return { warnings };
}

export function parseJsoncObject(text: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(stripJsonComments(text));
  if (!isPlainObject(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed;
}

function scanModelsJson(
  path: string,
  options: ModelConfigSecurityOptions,
  warnings: string[],
): void {
  const root = parseJsoncObject(readFileSync(path, "utf8"), "models.json");
  assertOnlyKeys(root, ["providers"], "models.json");
  const providers = requiredObject(root.providers, "models.json.providers");

  for (const [provider, rawProviderConfig] of Object.entries(providers)) {
    if (!options.allowedProviders.has(provider)) {
      throw new Error(`Model provider ${provider} is not enabled on this deployment`);
    }
    const providerConfig = requiredObject(rawProviderConfig, `models.json.providers.${provider}`);
    assertOnlyKeys(
      providerConfig,
      ["name", "baseUrl", "apiKey", "api", "headers", "compat", "authHeader", "models", "modelOverrides"],
      `models.json.providers.${provider}`,
    );

    const providerBaseUrl = scanOptionalUrl(
      providerConfig.baseUrl,
      `models.json.providers.${provider}.baseUrl`,
    );
    scanOptionalApi(providerConfig.api, `models.json.providers.${provider}.api`);
    scanOptionalConfigValue(providerConfig.apiKey, `models.json.providers.${provider}.apiKey`, options.allowCommands === true);
    maybeWarnLiteralCredential(
      warnings,
      providerConfig.apiKey,
      `models.json.providers.${provider}.apiKey`,
      providerBaseUrl,
    );
    scanHeaders(
      providerConfig.headers,
      `models.json.providers.${provider}.headers`,
      options.allowCommands === true,
      warnings,
    );
    scanCompat(providerConfig.compat, `models.json.providers.${provider}.compat`);

    if (providerConfig.models !== undefined) {
      if (!Array.isArray(providerConfig.models)) {
        throw new Error(`models.json.providers.${provider}.models must be an array`);
      }
      for (const [index, rawModel] of providerConfig.models.entries()) {
        const modelPath = `models.json.providers.${provider}.models[${index}]`;
        const model = requiredObject(rawModel, modelPath);
        assertOnlyKeys(
          model,
          ["id", "name", "api", "baseUrl", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens", "headers", "compat"],
          modelPath,
        );
        scanOptionalApi(model.api, `${modelPath}.api`);
        scanOptionalUrl(model.baseUrl, `${modelPath}.baseUrl`);
        scanHeaders(
          model.headers,
          `${modelPath}.headers`,
          options.allowCommands === true,
          warnings,
        );
        scanThinkingLevelMap(model.thinkingLevelMap, `${modelPath}.thinkingLevelMap`);
        scanCost(model.cost, `${modelPath}.cost`, false);
        scanCompat(model.compat, `${modelPath}.compat`);
      }
    }

    if (providerConfig.modelOverrides !== undefined) {
      const overrides = requiredObject(providerConfig.modelOverrides, `models.json.providers.${provider}.modelOverrides`);
      for (const [modelId, rawOverride] of Object.entries(overrides)) {
        const overridePath = `models.json.providers.${provider}.modelOverrides.${modelId}`;
        const override = requiredObject(rawOverride, overridePath);
        assertOnlyKeys(
          override,
          ["name", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens", "headers", "compat"],
          overridePath,
        );
        scanHeaders(
          override.headers,
          `${overridePath}.headers`,
          options.allowCommands === true,
          warnings,
        );
        scanThinkingLevelMap(override.thinkingLevelMap, `${overridePath}.thinkingLevelMap`);
        scanCost(override.cost, `${overridePath}.cost`, true);
        scanCompat(override.compat, `${overridePath}.compat`);
      }
    }
  }
}

function scanAuthJson(path: string, allowCommands: boolean): void {
  const auth = parseJsoncObject(readFileSync(path, "utf8"), "auth.json");
  for (const [provider, rawCredential] of Object.entries(auth)) {
    const credential = requiredObject(rawCredential, `auth.json.${provider}`);
    if (credential.type === "api_key") {
      scanOptionalConfigValue(credential.key, `auth.json.${provider}.key`, allowCommands);
    }
  }
}

function scanPathSafety(path: string, label: string): void {
  const resolved = resolve(path);
  const parent = dirname(resolved);
  if (existsSync(parent)) {
    const parentStat = lstatSync(parent);
    if (parentStat.isSymbolicLink()) {
      throw new Error(`${label} parent directory must not be a symlink: ${parent}`);
    }
    if ((parentStat.mode & 0o022) !== 0) {
      throw new Error(`${label} parent directory must not be group/world writable: ${parent}`);
    }
  }
  if (!existsSync(resolved)) return;
  const lst = lstatSync(resolved);
  if (lst.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${resolved}`);
  }
  const st = statSync(resolved);
  if (!st.isFile()) {
    throw new Error(`${label} must be a regular file: ${resolved}`);
  }
  if ((st.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group/world writable: ${resolved}`);
  }
}

function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      out += "  ";
      i += 1;
      while (i + 1 < text.length && text[i + 1] !== "\n" && text[i + 1] !== "\r") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 1;
      while (i + 1 < text.length && !(text[i + 1] === "*" && text[i + 2] === "/")) {
        out += text[i + 1] === "\n" || text[i + 1] === "\r" ? text[i + 1]! : " ";
        i += 1;
      }
      if (i + 2 < text.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function scanOptionalApi(value: unknown, path: string): void {
  if (value === undefined) return;
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  if (!(SUPPORTED_PI_MODEL_APIS as readonly string[]).includes(value)) {
    throw new Error(`${path} uses unsupported Pi model adapter ${JSON.stringify(value)}`);
  }
}

function scanOptionalUrl(value: unknown, path: string): URL | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${path} must be a valid URL`);
  }
  if (url.username || url.password) {
    throw new Error(`${path} must not contain username/password userinfo`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
  throw new Error(`${path} must be https, or http only for syntactic loopback hosts`);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]" || normalized === "::1") return true;
  if (isIP(normalized) === 4) {
    const [first] = normalized.split(".");
    return first === "127";
  }
  return false;
}

function scanOptionalConfigValue(value: unknown, path: string, allowCommands: boolean): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string`);
  if (value.startsWith("!") && !allowCommands) {
    throw new Error(`${path} uses command-backed auth; set OMA_ALLOW_MODEL_AUTH_COMMANDS=true to allow it`);
  }
}

function maybeWarnLiteralCredential(
  warnings: string[],
  value: unknown,
  path: string,
  baseUrl: URL | undefined,
): void {
  if (typeof value !== "string") return;
  if (value.startsWith("$") || value.startsWith("!") || value === "") return;
  if (value === "oma-local-keyless" && baseUrl?.protocol === "http:" && isLoopbackHost(baseUrl.hostname)) return;
  warnings.push(`${path} contains a literal credential; prefer auth.json or environment interpolation`);
}

function scanHeaders(
  value: unknown,
  path: string,
  allowCommands: boolean,
  warnings: string[],
): void {
  if (value === undefined) return;
  const headers = requiredObject(value, path);
  for (const [name, headerValue] of Object.entries(headers)) {
    scanOptionalConfigValue(headerValue, `${path}.${name}`, allowCommands);
    if (
      typeof headerValue === "string" &&
      !headerValue.startsWith("$") &&
      !headerValue.startsWith("!") &&
      /authorization|api[-_]?key|token|secret/i.test(name)
    ) {
      warnings.push(
        `${path}.${name} contains a literal credential-like header; prefer auth.json or environment interpolation`,
      );
    }
  }
}

function scanThinkingLevelMap(value: unknown, path: string): void {
  if (value === undefined) return;
  const map = requiredObject(value, path);
  assertOnlyKeys(map, ["off", "minimal", "low", "medium", "high", "xhigh", "max"], path);
  for (const [key, item] of Object.entries(map)) {
    if (item !== null && typeof item !== "string") throw new Error(`${path}.${key} must be a string or null`);
  }
}

function scanCost(value: unknown, path: string, partial: boolean): void {
  if (value === undefined) return;
  const cost = requiredObject(value, path);
  assertOnlyKeys(cost, ["input", "output", "cacheRead", "cacheWrite", "tiers"], path);
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (cost[key] !== undefined && typeof cost[key] !== "number") throw new Error(`${path}.${key} must be a number`);
    if (!partial && cost[key] === undefined && cost.tiers === undefined) {
      // Pi still owns full semantic validation; this only prevents odd non-numeric values.
    }
  }
  if (cost.tiers !== undefined) {
    if (!Array.isArray(cost.tiers)) throw new Error(`${path}.tiers must be an array`);
    for (const [index, rawTier] of cost.tiers.entries()) {
      const tierPath = `${path}.tiers[${index}]`;
      const tier = requiredObject(rawTier, tierPath);
      assertOnlyKeys(tier, ["inputTokensAbove", "input", "output", "cacheRead", "cacheWrite"], tierPath);
      for (const key of ["inputTokensAbove", "input", "output", "cacheRead", "cacheWrite"]) {
        if (typeof tier[key] !== "number") throw new Error(`${tierPath}.${key} must be a number`);
      }
    }
  }
}

function scanCompat(value: unknown, path: string): void {
  if (value === undefined) return;
  const compat = requiredObject(value, path);
  assertOnlyKeys(
    compat,
    [
      "supportsStore",
      "supportsDeveloperRole",
      "supportsReasoningEffort",
      "supportsUsageInStreaming",
      "maxTokensField",
      "requiresToolResultName",
      "requiresAssistantAfterToolResult",
      "requiresThinkingAsText",
      "requiresReasoningContentOnAssistantMessages",
      "thinkingFormat",
      "chatTemplateKwargs",
      "cacheControlFormat",
      "openRouterRouting",
      "vercelGatewayRouting",
      "supportsStrictMode",
      "supportsLongCacheRetention",
      "sendSessionIdHeader",
      "supportsEagerToolInputStreaming",
      "sendSessionAffinityHeaders",
      "supportsCacheControlOnTools",
      "forceAdaptiveThinking",
    ],
    path,
  );
  if (compat.openRouterRouting !== undefined) scanOpenRouterRouting(compat.openRouterRouting, `${path}.openRouterRouting`);
  if (compat.vercelGatewayRouting !== undefined) scanVercelGatewayRouting(compat.vercelGatewayRouting, `${path}.vercelGatewayRouting`);
  if (compat.chatTemplateKwargs !== undefined) scanChatTemplateKwargs(compat.chatTemplateKwargs, `${path}.chatTemplateKwargs`);
}

function scanOpenRouterRouting(value: unknown, path: string): void {
  const routing = requiredObject(value, path);
  assertOnlyKeys(
    routing,
    [
      "allow_fallbacks",
      "require_parameters",
      "data_collection",
      "zdr",
      "enforce_distillable_text",
      "order",
      "only",
      "ignore",
      "quantizations",
      "sort",
      "max_price",
      "preferred_min_throughput",
      "preferred_max_latency",
    ],
    path,
  );
  if (routing.sort !== undefined && isPlainObject(routing.sort)) {
    assertOnlyKeys(routing.sort, ["by", "partition"], `${path}.sort`);
  }
  if (routing.max_price !== undefined) {
    assertOnlyKeys(requiredObject(routing.max_price, `${path}.max_price`), ["prompt", "completion", "image", "audio", "request"], `${path}.max_price`);
  }
  for (const key of ["preferred_min_throughput", "preferred_max_latency"]) {
    const item = routing[key];
    if (isPlainObject(item)) assertOnlyKeys(item, ["p50", "p75", "p90", "p99"], `${path}.${key}`);
  }
}

function scanVercelGatewayRouting(value: unknown, path: string): void {
  assertOnlyKeys(requiredObject(value, path), ["only", "order"], path);
}

function scanChatTemplateKwargs(value: unknown, path: string): void {
  const kwargs = requiredObject(value, path);
  for (const [key, rawValue] of Object.entries(kwargs)) {
    if (isPlainObject(rawValue)) {
      assertOnlyKeys(rawValue, ["$var", "omitWhenOff"], `${path}.${key}`);
      if (rawValue.$var !== "thinking.enabled" && rawValue.$var !== "thinking.effort") {
        throw new Error(`${path}.${key}.$var must reference a supported Pi variable`);
      }
    } else if (
      rawValue !== null &&
      typeof rawValue !== "string" &&
      typeof rawValue !== "number" &&
      typeof rawValue !== "boolean"
    ) {
      throw new Error(`${path}.${key} must be a scalar or variable object`);
    }
  }
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new Error(`${path}.${key} is not supported by OMA's Pi model security profile`);
    }
  }
}

function requiredObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${path} must be an object`);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
