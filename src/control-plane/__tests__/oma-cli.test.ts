import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../../bin/oma.mjs", import.meta.url));

function run(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: process.env,
  });
}

describe("oma CLI", () => {
  it("documents the foreground alpha workflow and planned lifecycle commands", () => {
    const result = run(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("oma up [--sandbox docker|microsandbox]");
    expect(result.stdout).toContain("oma smoke");
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

  it("rejects unknown sandbox selections before startup", () => {
    const result = run(["up", "--sandbox", "host"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unsupported sandbox");
  });
});
