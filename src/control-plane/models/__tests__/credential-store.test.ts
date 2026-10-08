import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryAuthStorageBackend, OmaCredentialStore } from "../credential-store.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A command-backed key that leaves a marker file, so the tests observe whether
// the command actually ran rather than what read() returned.
function commandKey(): { key: string; marker: string } {
  const root = mkdtempSync(join(tmpdir(), "oma-credential-store-"));
  roots.push(root);
  const marker = join(root, "executed");
  return { key: `!touch ${marker} && printf sk-from-command`, marker };
}

describe("OmaCredentialStore command policy", () => {
  it("refuses a command-backed key written after startup when commands are not allowed", async () => {
    // auth.json is re-read on every request, so the startup policy scan alone
    // cannot stop a key injected later (e.g. `oma auth set` on a live appliance).
    const { key, marker } = commandKey();
    const store = new OmaCredentialStore(new InMemoryAuthStorageBackend(), { commands: "deny" });
    await store.modify("anthropic", async () => ({ type: "api_key", key }));

    await expect(store.read("anthropic")).rejects.toThrow(/OMA_ALLOW_MODEL_AUTH_COMMANDS/);
    expect(existsSync(marker)).toBe(false);
  });

  it("reports command-backed keys without executing them for read-only diagnostics", async () => {
    const { key, marker } = commandKey();
    const store = new OmaCredentialStore(
      new InMemoryAuthStorageBackend({ anthropic: { type: "api_key", key } }),
      { commands: "unresolved" },
    );

    await expect(store.read("anthropic")).resolves.toMatchObject({ type: "api_key" });
    expect(existsSync(marker)).toBe(false);
  });

  it("executes command-backed keys only when the operator opted in", async () => {
    const { key, marker } = commandKey();
    const store = new OmaCredentialStore(
      new InMemoryAuthStorageBackend({ anthropic: { type: "api_key", key } }),
      { commands: "execute" },
    );

    await expect(store.read("anthropic")).resolves.toMatchObject({ key: "sk-from-command" });
    expect(existsSync(marker)).toBe(true);
  });
});

describe("InMemoryAuthStorageBackend", () => {
  it("serializes concurrent modifies so neither write is lost", async () => {
    const store = new OmaCredentialStore(new InMemoryAuthStorageBackend());
    const slow = store.modify("a", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { type: "api_key", key: "ka" };
    });
    const fast = store.modify("b", async () => ({ type: "api_key", key: "kb" }));
    await Promise.all([slow, fast]);

    expect((await store.list()).map((entry) => entry.providerId).sort()).toEqual(["a", "b"]);
  });
});
