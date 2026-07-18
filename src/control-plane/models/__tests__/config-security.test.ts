import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SUPPORTED_PI_MODEL_APIS,
  parseJsoncObject,
  scanModelConfigSecurity,
} from "../config-security.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "oma-model-security-"));
  roots.push(root);
  return root;
}

function writeFile(root: string, name: string, content: string, mode = 0o600): string {
  const path = join(root, name);
  writeFileSync(path, content, { mode });
  return path;
}

function validModelsJson(extraProviderFields = ""): string {
  return `{
    // JSONC comments are accepted before Pi construction.
    "providers": {
      "local": {
        "baseUrl": "http://localhost:11434",
        "apiKey": "oma-local-keyless",
        "api": "openai-responses",
        ${extraProviderFields}
        "headers": {"X-Gateway": "$OMA_GATEWAY_HEADER"},
        "models": [{
          "id": "local-model",
          "api": "openai-responses",
          "baseUrl": "http://127.0.0.1:11434",
          "reasoning": false,
          "thinkingLevelMap": {"off": null, "medium": "medium"},
          "input": ["text"],
          "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
          "contextWindow": 128000,
          "maxTokens": 4096,
          "compat": {"supportsDeveloperRole": true}
        }]
      }
    }
  }`;
}

describe("Pi model config security scan", () => {
  it("accepts JSONC, supported adapters, loopback HTTP, dynamic headers, and the local keyless placeholder", () => {
    const root = tempRoot();
    const modelsPath = writeFile(root, "models.json", validModelsJson());

    const report = scanModelConfigSecurity({
      modelsPath,
      allowedProviders: new Set(["local"]),
    });

    expect(report.warnings).toEqual([]);
    expect(SUPPORTED_PI_MODEL_APIS).toContain("openai-codex-responses");
  });

  it("rejects unknown keys and unsupported adapters before Pi construction", () => {
    const root = tempRoot();
    const unknownKeyPath = writeFile(root, "unknown.json", validModelsJson(`"streamSimple": "bad",`));
    const badApiPath = writeFile(root, "bad-api.json", validModelsJson().replace('"api": "openai-responses"', '"api": "made-up"'));

    expect(() =>
      scanModelConfigSecurity({ modelsPath: unknownKeyPath, allowedProviders: new Set(["local"]) }),
    ).toThrow(/streamSimple is not supported/);
    expect(() =>
      scanModelConfigSecurity({ modelsPath: badApiPath, allowedProviders: new Set(["local"]) }),
    ).toThrow(/unsupported Pi model adapter/);
  });

  it("rejects providers outside the deployment allowlist", () => {
    const root = tempRoot();
    const modelsPath = writeFile(root, "models.json", validModelsJson());

    expect(() =>
      scanModelConfigSecurity({ modelsPath, allowedProviders: new Set(["anthropic"]) }),
    ).toThrow(/Model provider local is not enabled/);
  });

  it("rejects unsafe URLs and URL userinfo", () => {
    const root = tempRoot();
    const remoteHttp = writeFile(root, "remote-http.json", validModelsJson().replace("http://localhost:11434", "http://api.example.com"));
    const userinfo = writeFile(root, "userinfo.json", validModelsJson().replace("http://localhost:11434", "https://user:pass@example.com"));

    expect(() =>
      scanModelConfigSecurity({ modelsPath: remoteHttp, allowedProviders: new Set(["local"]) }),
    ).toThrow(/must be https, or http only/);
    expect(() =>
      scanModelConfigSecurity({ modelsPath: userinfo, allowedProviders: new Set(["local"]) }),
    ).toThrow(/must not contain username\/password/);
  });

  it("rejects command-backed credentials and headers unless explicitly enabled", () => {
    const root = tempRoot();
    const modelsPath = writeFile(root, "models.json", validModelsJson().replace("$OMA_GATEWAY_HEADER", "!security find-key"));
    const authPath = writeFile(root, "auth.json", `{"openai":{"type":"api_key","key":"!security find-key"}}`);

    expect(() =>
      scanModelConfigSecurity({ modelsPath, authPath, allowedProviders: new Set(["local"]) }),
    ).toThrow(/command-backed auth/);
    expect(() =>
      scanModelConfigSecurity({ modelsPath, authPath, allowedProviders: new Set(["local"]), allowCommands: true }),
    ).not.toThrow();
  });

  it("warns on literal models.json credentials except the exact loopback keyless placeholder", () => {
    const root = tempRoot();
    const remote = writeFile(root, "remote.json", validModelsJson().replace("http://localhost:11434", "https://api.example.com").replace("oma-local-keyless", "literal-secret"));
    const localButWrongValue = writeFile(root, "local-wrong.json", validModelsJson().replace("oma-local-keyless", "literal-secret"));

    expect(scanModelConfigSecurity({ modelsPath: remote, allowedProviders: new Set(["local"]) }).warnings).toEqual([
      expect.stringContaining("literal credential"),
    ]);
    expect(scanModelConfigSecurity({ modelsPath: localButWrongValue, allowedProviders: new Set(["local"]) }).warnings).toEqual([
      expect.stringContaining("literal credential"),
    ]);
  });

  it("warns on literal credential-like headers without logging their values", () => {
    const root = tempRoot();
    const modelsPath = writeFile(
      root,
      "literal-header.json",
      validModelsJson().replace(
        '"X-Gateway": "$OMA_GATEWAY_HEADER"',
        '"Authorization": "Bearer literal-secret"',
      ),
    );

    const report = scanModelConfigSecurity({
      modelsPath,
      allowedProviders: new Set(["local"]),
    });

    expect(report.warnings).toEqual([
      expect.stringContaining("literal credential-like header"),
    ]);
    expect(report.warnings.join(" ")).not.toContain("Bearer literal-secret");
  });

  it("rejects symlinked and group/world-writable operator files", () => {
    const root = tempRoot();
    const target = writeFile(root, "target.json", validModelsJson());
    const link = join(root, "models-link.json");
    symlinkSync(target, link);
    const writable = writeFile(root, "writable.json", validModelsJson(), 0o666);
    chmodSync(writable, 0o666);

    expect(() =>
      scanModelConfigSecurity({ modelsPath: link, allowedProviders: new Set(["local"]) }),
    ).toThrow(/must not be a symlink/);
    expect(() =>
      scanModelConfigSecurity({ modelsPath: writable, allowedProviders: new Set(["local"]) }),
    ).toThrow(/must not be group\/world writable/);
  });

  it("strips comments without touching strings", () => {
    expect(parseJsoncObject(`{"url":"https://example.com/a//b","ok":true}// trailing`, "sample")).toEqual({
      url: "https://example.com/a//b",
      ok: true,
    });
  });
});
