import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAdminAuth,
  generateAdminKey,
  loadAdminKey,
} from "../admin/auth.ts";

const ADMIN_KEY = generateAdminKey();

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("admin auth", () => {
  it("loads a direct key or file key and rejects ambiguous or weak config", () => {
    expect(loadAdminKey({})).toBeUndefined();
    expect(loadAdminKey({ OMA_ADMIN_KEY: ` ${ADMIN_KEY} ` })).toBe(ADMIN_KEY);

    const root = mkdtempSync(join(tmpdir(), "oma-admin-auth-"));
    tempRoots.push(root);
    const keyFile = join(root, "admin-key");
    writeFileSync(keyFile, `${ADMIN_KEY}\n`);
    expect(loadAdminKey({ OMA_ADMIN_KEY_FILE: keyFile })).toBe(ADMIN_KEY);

    expect(() =>
      loadAdminKey({
        OMA_ADMIN_KEY: ADMIN_KEY,
        OMA_ADMIN_KEY_FILE: keyFile,
      }),
    ).toThrow("set exactly one");
    expect(() =>
      loadAdminKey({ OMA_ADMIN_KEY: "not-a-canonical-256-bit-key" }),
    ).toThrow("exactly 32 random bytes");
  });

  it("verifies only the exact admin key without retaining plaintext fields", () => {
    const auth = createAdminAuth(ADMIN_KEY);
    expect(auth.verify(ADMIN_KEY)).toBe(true);
    expect(auth.verify(`${ADMIN_KEY}x`)).toBe(false);
    expect(auth.verify("short")).toBe(false);
    expect(Object.values(auth)).not.toContain(ADMIN_KEY);
    expect(JSON.stringify(auth)).not.toContain(ADMIN_KEY);
  });
});
