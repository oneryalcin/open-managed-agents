import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../../bin/oma.mjs", import.meta.url));

const tempHomes: string[] = [];

afterEach(() => {
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("oma CLI", () => {
  it("documents the foreground alpha workflow and planned lifecycle commands", () => {
    const result = run(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("oma up [--sandbox docker|microsandbox]");
    expect(result.stdout).toContain("oma smoke");
    expect(result.stdout).toContain("oma keys mint");
    expect(result.stdout).toContain("oma workspaces list");
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
});
