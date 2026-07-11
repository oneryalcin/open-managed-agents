import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSkillsStore } from "../store.ts";
import { InMemorySkillsStore } from "../store.ts";

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
    const beforeDelete = objectFiles(root).length;
    expect(store.deleteVersion("wrk_default", first.id, second.version)).toBe(true);
    expect(store.getSkill("wrk_default", first.id)?.latest_version).toBe(firstVersion);
    expect(store.openContent("wrk_default", first.id, second.version, "demo/SKILL.md")).toBeUndefined();
    expect(objectFiles(root)).toHaveLength(beforeDelete - 1);
    db.close();
  });

  it("resolves the latest alias when deleting a version", () => {
    const store = new InMemorySkillsStore();
    const skill = store.createSkill("wrk_default", "Alias", bundle("alias", "one"));
    expect(store.deleteVersion("wrk_default", skill.id, "latest")).toBe(true);
    expect(store.getSkill("wrk_default", skill.id)?.latest_version).toBeNull();
    expect(store.getVersion("wrk_default", skill.id, "latest")).toBeUndefined();
    store.close();
  });

  it("rolls back staged objects when a write fails mid-publish", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-skills-rollback-")); roots.push(root);
    const db = new DatabaseSync(":memory:");
    const store = new SqliteSkillsStore(db, root);
    const original = (store as any).writeObject.bind(store);
    let writes = 0;
    (store as any).writeObject = (id: string, bytes: Uint8Array) => {
      if (++writes === 2) throw new Error("injected write failure");
      original(id, bytes);
    };
    expect(() => store.createSkill("wrk_default", "Rollback", bundleWithScript("rollback"))).toThrow(/injected/);
    expect((db.prepare("SELECT COUNT(*) n FROM skills").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) n FROM pending_skill_content_rollbacks").get() as { n: number }).n).toBe(0);
    expect(objectFiles(root)).toHaveLength(0);
    db.close();
  });

  it("sweeps durable rollback intents on restart", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-skills-restart-")); roots.push(root);
    const db = new DatabaseSync(":memory:");
    const first = new SqliteSkillsStore(db, root);
    const id = "skobj_orphan";
    const shard = createHash("sha256").update(id).digest("hex").slice(0, 2);
    const path = join(root, "skill-objects", shard, id);
    mkdirSync(join(root, "skill-objects", shard), { recursive: true });
    writeFileSync(path, "orphan");
    db.prepare("INSERT INTO pending_skill_content_rollbacks VALUES (?,?,?)").run("wrk_default", id, new Date().toISOString());
    expect(existsSync(path)).toBe(true);
    void first;
    new SqliteSkillsStore(db, root);
    expect(existsSync(path)).toBe(false);
    expect((db.prepare("SELECT COUNT(*) n FROM pending_skill_content_rollbacks").get() as { n: number }).n).toBe(0);
    db.close();
  });

  it("enforces the retained-version cap", () => {
    const store = new InMemorySkillsStore({ maxVersions: 1 });
    const skill = store.createSkill("wrk_default", "Capped", bundle("capped", "one"));
    expect(() => store.createVersion("wrk_default", skill.id, bundle("capped", "two"))).toThrow(/at most 1 versions/);
    store.close();
  });

  it("enforces an independent workspace byte quota", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-skills-quota-")); roots.push(root);
    const db = new DatabaseSync(":memory:");
    const store = new SqliteSkillsStore(db, root, { maxWorkspaceBytes: 10 });
    expect(() => store.createSkill("wrk_default", "Demo", bundle("demo", "long description"))).toThrow(/quota/i);
    db.close();
  });

  it("keeps the fallback store fully memory-backed and represents zero versions explicitly", () => {
    const store = new InMemorySkillsStore();
    const skill = store.createSkill("wrk_default", "Memory", bundle("memory", "one"));
    const version = skill.latest_version!;
    expect(store.deleteVersion("wrk_default", skill.id, version)).toBe(true);
    expect(store.getSkill("wrk_default", skill.id)?.latest_version).toBeNull();
    expect(store.getVersion("wrk_default", skill.id, "latest")).toBeUndefined();
    store.close();
  });

  it("returns not-found when the owner disappears before createVersion commits", () => {
    const store = new InMemorySkillsStore();
    expect(() =>
      store.createVersion("wrk_default", "skill_missing", bundle("missing", "race")),
    ).toThrow(/Skill skill_missing not found/);
    store.close();
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

function bundleWithScript(name: string) {
  const base = bundle(name, "rollback");
  const bytes = new TextEncoder().encode("echo ok\n");
  const sha = createHash("sha256").update(bytes).digest("hex");
  return {
    ...base,
    totalBytes: base.totalBytes + bytes.byteLength,
    files: [...base.files, { path: `${name}/scripts/run.sh`, bytes, size: bytes.byteLength, sha256: sha }],
  };
}

function objectFiles(root: string): string[] {
  const directory = join(root, "skill-objects");
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}
