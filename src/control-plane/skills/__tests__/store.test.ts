import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSkillsStore } from "../store.ts";

describe("SqliteSkillsStore", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it("keeps content private, recomputes latest, and reclaims version objects", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-skills-store-")); roots.push(root);
    const db = new DatabaseSync(":memory:");
    const store = new SqliteSkillsStore(db, root);
    const first = store.createSkill("wrk_default", "Demo", bundle("demo", "first"));
    const firstVersion = first.latest_version;
    const second = store.createVersion("wrk_default", first.id, bundle("demo", "second"));
    expect(store.openContent("wrk_default", first.id, second.version, "demo/SKILL.md")).toEqual(expect.any(Uint8Array));
    expect(store.getVersion("wrk_other", first.id, second.version)).toBeUndefined();
    expect(store.deleteVersion("wrk_default", first.id, second.version)).toBe(true);
    expect(store.getSkill("wrk_default", first.id)?.latest_version).toBe(firstVersion);
    expect(store.openContent("wrk_default", first.id, second.version, "demo/SKILL.md")).toBeUndefined();
    db.close();
  });

  it("enforces an independent workspace byte quota", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-skills-quota-")); roots.push(root);
    const db = new DatabaseSync(":memory:");
    const store = new SqliteSkillsStore(db, root, { maxWorkspaceBytes: 10 });
    expect(() => store.createSkill("wrk_default", "Demo", bundle("demo", "long description"))).toThrow(/quota/i);
    db.close();
  });
});

function bundle(name: string, description: string) {
  const bytes = new TextEncoder().encode(`---\nname: ${name}\ndescription: ${description}\n---\n`);
  const sha = createHash("sha256").update(bytes).digest("hex");
  return {
    name, description, directory: name, totalBytes: bytes.byteLength,
    manifestSha256: sha,
    files: [{ path: `${name}/SKILL.md`, bytes, size: bytes.byteLength, sha256: sha }],
  };
}
