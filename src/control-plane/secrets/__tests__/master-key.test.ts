import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateMasterKey, loadMasterKey } from "../master-key.ts";

// The master key is the root of trust for every secret at rest (ADR 0016 §4).
// These tests lock in the strict format contract: a weak or misparsed key must
// be refused at load, never silently derived from.

describe("loadMasterKey", () => {
  const work = mkdtempSync(join(tmpdir(), "oma-master-key-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("loads a canonical 32-byte base64 key from OMA_MASTER_KEY", () => {
    const raw = randomBytes(32);
    const key = loadMasterKey({ OMA_MASTER_KEY: raw.toString("base64") });
    expect(key.equals(raw)).toBe(true);
  });

  it("loads the key from OMA_MASTER_KEY_FILE (trailing newline tolerated)", () => {
    const raw = randomBytes(32);
    const path = join(work, "key");
    writeFileSync(path, `${raw.toString("base64")}\n`);
    const key = loadMasterKey({ OMA_MASTER_KEY_FILE: path });
    expect(key.equals(raw)).toBe(true);
  });

  it("generateMasterKey output round-trips through loadMasterKey", () => {
    const generated = generateMasterKey();
    expect(loadMasterKey({ OMA_MASTER_KEY: generated }).length).toBe(32);
  });

  it("refuses when neither env var is set", () => {
    expect(() => loadMasterKey({})).toThrow(/OMA_MASTER_KEY/);
  });

  it("refuses when both env vars are set (ambiguous source)", () => {
    expect(() =>
      loadMasterKey({ OMA_MASTER_KEY: "x", OMA_MASTER_KEY_FILE: "/y" }),
    ).toThrow(/exactly one/);
  });

  it.each([
    ["a passphrase", "correct horse battery staple"],
    ["hex of 32 bytes", randomBytes(32).toString("hex")],
    ["too few bytes", randomBytes(16).toString("base64")],
    ["too many bytes", randomBytes(48).toString("base64")],
    ["empty", ""],
  ])("refuses %s — HKDF is not a password KDF", (_label, value) => {
    expect(() => loadMasterKey({ OMA_MASTER_KEY: value })).toThrow(
      /32 random bytes/,
    );
  });
});
