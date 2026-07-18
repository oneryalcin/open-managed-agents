import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../../bin/oma.mjs", import.meta.url));

const tempHomes: string[] = [];

afterEach(() => {
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}, input?: string) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    input,
  });
}

function modelEnv(home: string, extra: Record<string, string> = {}) {
  return {
    OMA_HOME: home,
    OMA_MODEL_PROVIDERS: "anthropic",
    OMA_DEFAULT_MODEL_PROVIDER: "anthropic",
    OMA_DEFAULT_MODEL: "claude-sonnet-5",
    ...extra,
  };
}

describe("oma CLI", () => {
  it("documents the foreground alpha workflow and planned lifecycle commands", () => {
    const result = run(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("oma up [--sandbox docker|microsandbox]");
    expect(result.stdout).toContain("oma smoke [--sandbox docker|microsandbox] [--local-compatible]");
    expect(result.stdout).toContain("oma keys mint");
    expect(result.stdout).toContain("oma workspaces list");
    expect(result.stdout).toContain("oma providers status");
    expect(result.stdout).toContain("oma models list");
    expect(result.stdout).toContain("oma auth set <provider>");
    expect(result.stdout).toContain("oma admin init");
    expect(result.stdout).toContain("oma admin status");
    expect(result.stdout).toContain("Planned, not implemented yet:");
    expect(result.stdout).toContain("oma up --detach");
    expect(result.stdout).toContain("oma logs");
    expect(result.stdout).toContain("oma down");
  });

  it("prints the package version", () => {
    const result = run(["--version"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("oma 0.0.1");
  });

  it("fails honestly for detached lifecycle commands", () => {
    const detached = run(["up", "--detach"]);
    expect(detached.status).toBe(2);
    expect(detached.stderr).toContain("Detached mode is not implemented yet");

    const down = run(["down"]);
    expect(down.status).toBe(2);
    expect(down.stderr).toContain("down is not implemented yet");
  });

  it("validates local key-management arguments before provisioning", () => {
    const result = run(["keys", "mint", "--workspace"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--workspace requires a value");
  });

  it("initializes an admin key once with owner-only permissions", () => {
    const home = mkdtempSync(join(tmpdir(), "oma-cli-admin-"));
    tempHomes.push(home);
    const env = { OMA_HOME: home, OMA_ADMIN_KEY: "" };

    const initialized = run(["admin", "init"], env);
    expect(initialized.status).toBe(0);
    const match = /Admin key: ([A-Za-z0-9+/]+={0,2})/.exec(initialized.stdout);
    expect(match?.[1]).toBeDefined();
    expect(Buffer.from(match![1], "base64")).toHaveLength(32);
    expect(readFileSync(join(home, "admin.key"), "utf8").trim()).toBe(match![1]);
    expect(statSync(join(home, "admin.key")).mode & 0o777).toBe(0o600);

    const status = run(["admin", "status"], env);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain(`Admin key file: ${join(home, "admin.key")}`);
    expect(status.stdout).toContain("Permissions: 600");

    const repeated = run(["admin", "init"], env);
    expect(repeated.status).toBe(2);
    expect(repeated.stderr).toContain("Refusing to overwrite");
    expect(readFileSync(join(home, "admin.key"), "utf8").trim()).toBe(match![1]);
  });

  it("rejects unknown sandbox selections before startup", () => {
    const result = run(["up", "--sandbox", "host"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unsupported sandbox");
  });

  it("lists and validates enabled Pi model providers without exposing credential labels", () => {
    const home = mkdtempSync(join(tmpdir(), "oma-cli-models-"));
    tempHomes.push(home);
    const env = modelEnv(home, { ANTHROPIC_API_KEY: "test-key-from-env" });

    const providers = run(["providers", "status"], env);
    expect(providers.status).toBe(0);
    expect(providers.stdout).toContain("provider\tname\tready_models\ttotal_models\tdefault");
    expect(providers.stdout).toContain("anthropic\tAnthropic");
    expect(providers.stdout).toContain("\ttrue\n");
    expect(providers.stdout).not.toContain("ANTHROPIC_API_KEY");
    expect(providers.stdout).not.toContain("test-key-from-env");

    const models = run(["models", "list", "--provider", "anthropic"], env);
    expect(models.status).toBe(0);
    expect(models.stdout).toContain("provider\tid\tname\tapi\tcredentials_configured\tdefault");
    expect(models.stdout).toContain("anthropic\tclaude-sonnet-5");
    expect(models.stdout).not.toContain("test-key-from-env");

    const validate = run(["models", "validate"], env);
    expect(validate.status).toBe(0);
    expect(validate.stdout).toContain("Model configuration is valid.");
    expect(validate.stdout).toContain("Default model: anthropic/claude-sonnet-5");
  });

  it("stores, reports, and idempotently removes provider auth without echoing keys", () => {
    const home = mkdtempSync(join(tmpdir(), "oma-cli-auth-"));
    tempHomes.push(home);
    const env = modelEnv(home, { ANTHROPIC_API_KEY: "" });

    const rejectedArg = run(["auth", "set", "anthropic", "plaintext"], env);
    expect(rejectedArg.status).toBe(2);
    expect(rejectedArg.stderr).toContain("does not accept API keys as command-line arguments");

    const rejectedLines = run(["auth", "set", "anthropic", "--stdin"], env, "one\ntwo\n");
    expect(rejectedLines.status).toBe(2);
    expect(rejectedLines.stderr).toContain("exactly one API key value");

    const stored = run(["auth", "set", "anthropic", "--stdin"], env, "secret-from-stdin\n");
    expect(stored.status).toBe(0);
    expect(stored.stdout).toContain("Stored API key for anthropic.");
    expect(stored.stdout).toContain("Restart `oma up`");
    expect(stored.stdout).not.toContain("secret-from-stdin");
    expect(readFileSync(join(home, "pi", "auth.json"), "utf8")).toContain("secret-from-stdin");

    const status = run(["auth", "status", "anthropic"], env);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain("provider\tstored\tready_models\ttotal_models");
    expect(status.stdout).toMatch(/anthropic\ttrue\t\d+\t\d+/);
    expect(status.stdout).not.toContain("secret-from-stdin");

    const removed = run(["auth", "remove", "anthropic"], env);
    expect(removed.status).toBe(0);
    expect(removed.stdout).toContain("Removed stored API key for anthropic");

    const repeated = run(["auth", "remove", "anthropic"], env);
    expect(repeated.status).toBe(0);
    expect(repeated.stdout).toContain("Removed stored API key for anthropic");

    const authPath = join(home, "pi", "auth.json");
    writeFileSync(authPath, JSON.stringify({
      anthropic: { type: "api_key", key: "keep-me" },
      openai: { type: "api_key", key: "remove-me" },
    }), { mode: 0o600 });
    const disabled = run(["auth", "remove", "openai"], env);
    expect(disabled.status).toBe(0);
    expect(disabled.stdout).toContain("Removed stored API key for openai");
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
      anthropic: { type: "api_key", key: "keep-me" },
    });
  }, 20_000);
});
