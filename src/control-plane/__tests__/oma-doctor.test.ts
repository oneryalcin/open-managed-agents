import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectOma } from "../../../scripts/oma-doctor.ts";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("oma doctor inspection boundary", () => {
  it("uses only local process and health checks and leaves missing state missing", async () => {
    const parent = mkdtempSync(join(tmpdir(), "oma-doctor-unit-"));
    roots.push(parent);
    const home = join(parent, "missing-home");
    const command = vi.fn(() => ({ status: 0, stdout: "", stderr: "" })) as never;
    const fetch = vi.fn(async () => new Response("ok")) as typeof globalThis.fetch;

    const report = await inspectOma({ sandbox: "docker-local" }, {
      env: {
        OMA_HOME: home,
        OMA_PORT: "4180",
        ANTHROPIC_API_KEY: "unit-secret-never-print",
      },
      command,
      fetch,
    });

    expect(report.ok).toBe(true);
    expect(command).toHaveBeenNthCalledWith(1, "docker", ["info"], { encoding: "utf8" });
    expect(command).toHaveBeenNthCalledWith(2, "docker", ["image", "inspect", expect.stringContaining("@sha256:")], { encoding: "utf8" });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4180/health", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(JSON.stringify(report)).not.toContain("unit-secret-never-print");
    expect(existsSync(home)).toBe(false);
  });

  it("keeps the no-paid-credential local-compatible path ready with a visible warning", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const parent = mkdtempSync(join(tmpdir(), "oma-doctor-no-credential-"));
    roots.push(parent);
    const home = join(parent, "missing-home");
    const report = await inspectOma({ sandbox: "docker-local" }, {
      env: { OMA_HOME: home, OMA_PORT: "4180" },
      command: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })) as never,
      fetch: vi.fn(async () => new Response("ok")) as typeof globalThis.fetch,
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: "models.credentials",
      status: "warn",
    }));
    expect(existsSync(home)).toBe(false);
  });
});
