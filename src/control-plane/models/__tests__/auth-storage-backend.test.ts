import { AuthStorage } from "@earendil-works/pi-coding-agent";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OmaAuthStorageBackend } from "../auth-storage-backend.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("OmaAuthStorageBackend", () => {
  it("creates owned 0700 directories and a 0600 auth file", () => {
    const authPath = tempAuthPath();
    const backend = new OmaAuthStorageBackend(authPath);

    backend.withLock(() => ({ result: undefined }));

    expect(statMode(dirname(authPath))).toBe(0o700);
    expect(statMode(authPath)).toBe(0o600);
    expect(readFileSync(authPath, "utf8")).toBe("{}");
  });

  it("preserves Pi auth schema through AuthStorage.set and remove", () => {
    const authPath = tempAuthPath();
    const auth = AuthStorage.fromStorage(new OmaAuthStorageBackend(authPath));

    auth.set("openai", { type: "api_key", key: "sk-one" });
    auth.set("anthropic", { type: "api_key", key: "sk-two" });
    auth.remove("openai");

    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
      anthropic: { type: "api_key", key: "sk-two" },
    });
  });

  it("passes the latest durable bytes to each sync callback", () => {
    const authPath = tempAuthPath();
    const first = new OmaAuthStorageBackend(authPath);
    const second = new OmaAuthStorageBackend(authPath);

    first.withLock(() => ({
      result: undefined,
      next: JSON.stringify({ anthropic: { type: "api_key", key: "one" } }),
    }));
    const seen = second.withLock((current) => ({
      result: current,
      next: JSON.stringify({
        ...JSON.parse(current ?? "{}"),
        openai: { type: "api_key", key: "two" },
      }),
    }));

    expect(JSON.parse(seen ?? "{}")).toEqual({
      anthropic: { type: "api_key", key: "one" },
    });
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
      anthropic: { type: "api_key", key: "one" },
      openai: { type: "api_key", key: "two" },
    });
  });

  it("serializes concurrent async callbacks without losing peer entries", async () => {
    const authPath = tempAuthPath();
    const first = new OmaAuthStorageBackend(authPath);
    const second = new OmaAuthStorageBackend(authPath);

    const writes = await Promise.all([
      first.withLockAsync(async (current) => {
        await delay(30);
        return {
          result: "anthropic",
          next: JSON.stringify({
            ...JSON.parse(current ?? "{}"),
            anthropic: { type: "api_key", key: "one" },
          }),
        };
      }),
      second.withLockAsync(async (current) => ({
        result: "openai",
        next: JSON.stringify({
          ...JSON.parse(current ?? "{}"),
          openai: { type: "api_key", key: "two" },
        }),
      })),
    ]);

    expect(writes.sort()).toEqual(["anthropic", "openai"]);
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
      anthropic: { type: "api_key", key: "one" },
      openai: { type: "api_key", key: "two" },
    });
  });

  it("keeps the old durable file when callback fails before returning replacement bytes", () => {
    const authPath = tempAuthPath();
    const backend = new OmaAuthStorageBackend(authPath);
    backend.withLock(() => ({ result: undefined, next: "{\"ok\":true}" }));

    expect(() => backend.withLock(() => {
      throw new Error("injected failure");
    })).toThrow("injected failure");

    expect(readFileSync(authPath, "utf8")).toBe("{\"ok\":true}");
    expect(listTempFiles(authPath)).toEqual([]);
  });

  it("keeps the old durable file when a crash is injected before atomic rename", () => {
    const authPath = tempAuthPath();
    const initial = new OmaAuthStorageBackend(authPath);
    initial.withLock(() => ({ result: undefined, next: "{\"old\":true}" }));
    const crashing = new OmaAuthStorageBackend(authPath, {
      beforeRename: () => {
        throw new Error("injected pre-rename crash");
      },
    });

    expect(() =>
      crashing.withLock(() => ({ result: undefined, next: "{\"new\":true}" })),
    ).toThrow("injected pre-rename crash");

    expect(readFileSync(authPath, "utf8")).toBe("{\"old\":true}");
    expect(listTempFiles(authPath)).toEqual([]);
  });

  it("keeps the old durable file when atomic rename fails", () => {
    const authPath = tempAuthPath();
    const backend = new OmaAuthStorageBackend(authPath);
    backend.withLock(() => ({ result: undefined, next: "{\"old\":true}" }));
    rmSync(authPath);
    mkdirSync(authPath, { mode: 0o700 });

    expect(() => backend.withLock(() => ({ result: undefined, next: "{\"new\":true}" })))
      .toThrow(/regular file|EISDIR|illegal operation/);

    expect(lstatSync(authPath).isDirectory()).toBe(true);
  });

  it("rejects unsafe existing directory permissions", () => {
    const authPath = tempAuthPath();
    chmodSync(dirname(authPath), 0o755);

    expect(() => new OmaAuthStorageBackend(authPath).withLock(() => ({ result: undefined })))
      .toThrow(/unsafe auth directory permissions 0755/);
  });

  it("rejects unsafe existing file permissions", () => {
    const authPath = tempAuthPath();
    writeFileSync(authPath, "{}", { mode: 0o644 });
    chmodSync(authPath, 0o644);

    expect(() => new OmaAuthStorageBackend(authPath).withLock(() => ({ result: undefined })))
      .toThrow(/unsafe auth file permissions 0644/);
  });

  it("rejects symlinked auth files", () => {
    const authPath = tempAuthPath();
    const target = join(rootFor(authPath), "target.json");
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, authPath);

    expect(() => new OmaAuthStorageBackend(authPath).withLock(() => ({ result: undefined })))
      .toThrow(/symlinked auth file/);
  });
});

function tempAuthPath(): string {
  const root = mkdtempSync(join(tmpdir(), "oma-auth-backend-"));
  roots.push(root);
  const dir = join(root, "pi");
  mkdirSync(dir, { mode: 0o700 });
  return join(dir, "auth.json");
}

function rootFor(authPath: string): string {
  return dirname(dirname(authPath));
}

function statMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function listTempFiles(authPath: string): string[] {
  const dir = dirname(authPath);
  return existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith(".tmp"))
    : [];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
