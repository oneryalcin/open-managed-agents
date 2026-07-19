import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
    expect(result.stdout).toContain("default: anthropic,openai,openrouter");
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

  it("makes every documented command and action help discoverable without side effects", () => {
    const home = join(tmpdir(), `oma-cli-help-missing-${process.pid}-${Date.now()}`);
    const topics = [
      ["up"], ["smoke"], ["keys"], ["keys", "mint"], ["keys", "list"],
      ["workspaces"], ["workspaces", "list"], ["providers"], ["providers", "status"],
      ["models"], ["models", "list"], ["models", "validate"], ["auth"],
      ["auth", "set"], ["auth", "status"], ["auth", "remove"], ["admin"],
      ["admin", "init"], ["admin", "status"], ["doctor"], ["version"],
    ];
    for (const topic of topics) {
      const direct = run([...topic, "--help"], { OMA_HOME: home });
      expect(direct.status, topic.join(" ")).toBe(0);
      expect(direct.stdout, topic.join(" ")).toContain(`Usage: oma ${topic.join(" ")}`);
      expect(direct.stdout, topic.join(" ")).toContain("Exit status:");
      const routed = run(["help", ...topic], { OMA_HOME: home });
      expect(routed.status, `help ${topic.join(" ")}`).toBe(0);
      expect(routed.stdout, `help ${topic.join(" ")}`).toContain(`Usage: oma ${topic.join(" ")}`);
    }
    expect(existsSync(home)).toBe(false);
  });

  it("runs doctor as a read-only, secret-safe JSON diagnostic", () => {
    const parent = mkdtempSync(join(tmpdir(), "oma-cli-doctor-"));
    tempHomes.push(parent);
    const home = join(parent, "missing-home");
    const sentinel = "oma-secret-sentinel-never-print";
    const result = run(["doctor", "--sandbox", "microsandbox", "--json"], {
      OMA_HOME: home,
      OMA_MICROSANDBOX_COMMAND: "oma-command-that-does-not-exist",
      ANTHROPIC_API_KEY: sentinel,
      OMA_PORT: "65534",
    });

    expect([0, 1]).toContain(result.status);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ schema_version: 1, ok: expect.any(Boolean) });
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "node.version" }),
      expect.objectContaining({ id: "models.catalog" }),
      expect.objectContaining({ id: "models.credentials", status: "pass" }),
      expect.objectContaining({ id: "sandbox.runtime", status: "fail" }),
    ]));
    expect(result.stdout).not.toContain(sentinel);
    expect(result.stderr).not.toContain(sentinel);
    expect(existsSync(home)).toBe(false);
  }, 20_000);

  it("does not rewrite or lock an existing auth snapshot while diagnosing it", () => {
    const home = mkdtempSync(join(tmpdir(), "oma-cli-doctor-existing-"));
    tempHomes.push(home);
    const pi = join(home, "pi");
    mkdirSync(pi, { mode: 0o700 });
    const sentinel = "oma-existing-auth-secret";
    const authPath = join(pi, "auth.json");
    writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: sentinel } }), { mode: 0o600 });
    const before = readFileSync(authPath, "utf8");
    const entriesBefore = readdirSync(pi);

    const result = run(["doctor", "--sandbox", "microsandbox", "--json"], {
      OMA_HOME: home,
      OMA_MICROSANDBOX_COMMAND: "oma-command-that-does-not-exist",
      OMA_PORT: "65533",
    });

    expect([0, 1]).toContain(result.status);
    expect(readFileSync(authPath, "utf8")).toBe(before);
    expect(readdirSync(pi)).toEqual(entriesBefore);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(sentinel);
  }, 20_000);

  it("fails closed before reading an auth file with unsafe permissions", () => {
    const home = mkdtempSync(join(tmpdir(), "oma-cli-doctor-unsafe-auth-"));
    tempHomes.push(home);
    const pi = join(home, "pi");
    mkdirSync(pi, { mode: 0o700 });
    const sentinel = "oma-world-readable-secret";
    writeFileSync(join(pi, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: sentinel } }), { mode: 0o644 });

    const result = run(["doctor", "--sandbox", "microsandbox", "--json"], {
      OMA_HOME: home,
      OMA_MICROSANDBOX_COMMAND: "oma-command-that-does-not-exist",
      OMA_PORT: "65532",
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).checks).toContainEqual(expect.objectContaining({
      id: "paths.pi_auth",
      status: "fail",
    }));
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(sentinel);
  }, 20_000);

  it("does not echo malformed auth contents", () => {
    const home = mkdtempSync(join(tmpdir(), "oma-cli-doctor-malformed-auth-"));
    tempHomes.push(home);
    const pi = join(home, "pi");
    mkdirSync(pi, { mode: 0o700 });
    const sentinel = "oma-malformed-secret-sentinel";
    writeFileSync(join(pi, "auth.json"), `{"anthropic":{"type":"api_key","key":"${sentinel}",}}`, { mode: 0o600 });

    const result = run(["doctor", "--sandbox", "microsandbox", "--json"], {
      OMA_HOME: home,
      OMA_MICROSANDBOX_COMMAND: "oma-command-that-does-not-exist",
      OMA_PORT: "65531",
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(sentinel);
    expect(JSON.parse(result.stdout).checks).toContainEqual(expect.objectContaining({
      id: "models.catalog",
      status: "fail",
      summary: expect.stringContaining("auth.json is not valid JSON"),
    }));
  }, 20_000);

  it("fails before following an unsafe OMA_HOME symlink", () => {
    const parent = mkdtempSync(join(tmpdir(), "oma-cli-doctor-home-symlink-"));
    tempHomes.push(parent);
    const target = join(parent, "target");
    const pi = join(target, "pi");
    mkdirSync(pi, { recursive: true, mode: 0o700 });
    const sentinel = "oma-symlinked-home-secret";
    writeFileSync(join(pi, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: sentinel } }), { mode: 0o600 });
    const linkedHome = join(parent, "linked-home");
    symlinkSync(target, linkedHome);

    const result = run(["doctor", "--sandbox", "microsandbox", "--json"], {
      OMA_HOME: linkedHome,
      OMA_MICROSANDBOX_COMMAND: "oma-command-that-does-not-exist",
      OMA_PORT: "65530",
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(sentinel);
    expect(JSON.parse(result.stdout).checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "paths.oma_home", status: "fail" }),
      expect.objectContaining({ id: "models.catalog", status: "fail" }),
    ]));
  }, 20_000);

  it("uses stable nonzero exit codes and points invalid input to the nearest help", () => {
    const badOption = run(["models", "list", "--wat"]);
    expect(badOption.status).toBe(2);
    expect(badOption.stderr).toContain("oma help models list");

    const badDoctor = run(["doctor", "--wat"]);
    expect(badDoctor.status).toBe(2);
    expect(badDoctor.stderr).toContain("oma doctor --help");
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
