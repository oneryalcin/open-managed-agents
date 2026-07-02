import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseAppliancePort,
  resolveApplianceEnv,
  startAppliance,
  type RunningAppliance,
} from "../../main.ts";
import { MANAGED_AGENTS_BETA } from "../app.ts";

const KEY_LINE = /x-api-key: (oma_[A-Za-z0-9_-]+)/;

describe("appliance boot (plan 0115)", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), "oma-appliance-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    return home;
  }

  async function boot(env: Record<string, string>): Promise<{
    appliance: RunningAppliance;
    logs: string[];
  }> {
    const logs: string[] = [];
    const appliance = await startAppliance(
      { ...env, OMA_PORT: env.OMA_PORT ?? "0" },
      { log: (line) => logs.push(line) },
    );
    cleanups.push(() => appliance.close());
    return { appliance, logs };
  }

  function listAgents(port: number, key?: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/v1/agents`, {
      headers: {
        "anthropic-beta": MANAGED_AGENTS_BETA,
        ...(key === undefined ? {} : { "x-api-key": key }),
      },
    });
  }

  it("first boot prints the minted key exactly once", async () => {
    const { logs } = await boot({ OMA_HOME: makeHome() });
    const keyLines = logs.filter((line) => KEY_LINE.test(line));
    expect(keyLines).toHaveLength(1);
  });

  it("rejects unauthenticated requests after first boot", async () => {
    const { appliance } = await boot({ OMA_HOME: makeHome() });
    const res = await listAgents(appliance.port);
    expect(res.status).toBe(401);
  });

  it("authenticates requests with the first-boot key", async () => {
    const { appliance, logs } = await boot({ OMA_HOME: makeHome() });
    const key = logs.map((l) => KEY_LINE.exec(l)?.[1]).find(Boolean)!;
    const res = await listAgents(appliance.port, key);
    expect(res.status).toBe(200);
  });

  it("does not mint again on second boot of the same home", async () => {
    const home = makeHome();
    const first = await boot({ OMA_HOME: home });
    await cleanups.pop()!(); // close the first appliance, releasing .oma.lock
    expect(first.logs.some((l) => KEY_LINE.test(l))).toBe(true);

    const second = await boot({ OMA_HOME: home });
    expect(second.logs.some((l) => KEY_LINE.test(l))).toBe(false);
  });

  it("keeps the first-boot key valid across restarts", async () => {
    const home = makeHome();
    const first = await boot({ OMA_HOME: home });
    const key = first.logs.map((l) => KEY_LINE.exec(l)?.[1]).find(Boolean)!;
    await cleanups.pop()!();

    const second = await boot({ OMA_HOME: home });
    const res = await listAgents(second.appliance.port, key);
    expect(res.status).toBe(200);
  });

  it("respects OMA_AUTH_MODE=disabled: no key minted, requests open", async () => {
    const { appliance, logs } = await boot({
      OMA_HOME: makeHome(),
      OMA_AUTH_MODE: "disabled",
    });
    expect(logs.some((l) => KEY_LINE.test(l))).toBe(false);
    const res = await listAgents(appliance.port);
    expect(res.status).toBe(200);
  });

  it("derives storage paths from OMA_HOME only when neither is explicit", () => {
    const resolved = resolveApplianceEnv({ OMA_HOME: "/x" });
    expect(resolved.OMA_SQLITE_PATH).toBe(join("/x", "oma.sqlite"));
    const explicit = resolveApplianceEnv({
      OMA_HOME: "/x",
      OMA_SQLITE_PATH: "/y/db.sqlite",
    });
    expect(explicit.OMA_SQLITE_PATH).toBe("/y/db.sqlite");
  });

  it("rejects a non-integer OMA_PORT", () => {
    expect(() => parseAppliancePort("http")).toThrow(/Invalid OMA_PORT/);
  });
});
