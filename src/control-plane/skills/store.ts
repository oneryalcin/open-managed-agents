import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { invalidRequest } from "../errors.ts";
import { newSkillContentObjectId, newSkillId, newSkillVersionId } from "../ids.ts";
import { withSqliteTransaction } from "../sqlite-transaction.ts";
import type { WorkspaceId } from "../workspace.ts";
import {
  DEFAULT_SKILLS_MAX_VERSIONS,
  DEFAULT_SKILLS_WORKSPACE_MAX_BYTES,
  type SkillObject,
  type SkillPage,
  type SkillsStore,
  type SkillVersionObject,
  type ValidatedSkillBundle,
} from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
 display_title TEXT NOT NULL, source TEXT NOT NULL, latest_version TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,name), UNIQUE(workspace_id,display_title)
);
CREATE TABLE IF NOT EXISTS skill_versions (
 workspace_id TEXT NOT NULL, skill_id TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL,
 description TEXT NOT NULL, directory TEXT NOT NULL, file_count INTEGER NOT NULL,
 total_bytes INTEGER NOT NULL, manifest_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id,skill_id,version), UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,skill_id) REFERENCES skills(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS skill_files (
 workspace_id TEXT NOT NULL, skill_id TEXT NOT NULL, version TEXT NOT NULL, path TEXT NOT NULL,
 size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, content_object_id TEXT NOT NULL UNIQUE,
 PRIMARY KEY(workspace_id,skill_id,version,path),
 FOREIGN KEY(workspace_id,skill_id,version) REFERENCES skill_versions(workspace_id,skill_id,version) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS pending_skill_content_rollbacks (
 workspace_id TEXT NOT NULL, content_object_id TEXT PRIMARY KEY, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_skill_content_deletes (
 workspace_id TEXT NOT NULL, content_object_id TEXT PRIMARY KEY, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS skills_list ON skills(workspace_id,id);
CREATE INDEX IF NOT EXISTS skill_versions_list ON skill_versions(workspace_id,skill_id,version);
`;

interface SkillRow { workspace_id: string; id: string; name: string; display_title: string; source: "custom"; latest_version: string | null; created_at: string; updated_at: string; }
interface VersionRow { workspace_id: string; skill_id: string; id: string; version: string; description: string; directory: string; file_count: number; total_bytes: number; manifest_sha256: string; created_at: string; }

let versionTick = 0;
function newVersion(): string {
  const base = Date.now() * 1000;
  versionTick = (versionTick + 1) % 1000;
  return String(base + versionTick);
}

export class SqliteSkillsStore implements SkillsStore {
  private readonly objectsDir: string | undefined;
  private readonly memoryObjects: Map<string, Uint8Array> | undefined;
  private readonly maxWorkspaceBytes: number;
  private readonly maxVersions: number;
  private readonly workspaceBytesStmt: StatementSync;

  constructor(protected readonly db: DatabaseSync, objectRoot: string | undefined, opts: { maxWorkspaceBytes?: number; maxVersions?: number } = {}) {
    this.objectsDir = objectRoot === undefined ? undefined : resolve(objectRoot, "skill-objects");
    this.memoryObjects = objectRoot === undefined ? new Map() : undefined;
    if (this.objectsDir !== undefined) {
      mkdirSync(this.objectsDir, { recursive: true, mode: 0o700 });
      chmodSync(this.objectsDir, 0o700);
    }
    db.exec(SCHEMA);
    this.maxWorkspaceBytes = opts.maxWorkspaceBytes ?? DEFAULT_SKILLS_WORKSPACE_MAX_BYTES;
    this.maxVersions = opts.maxVersions ?? DEFAULT_SKILLS_MAX_VERSIONS;
    this.workspaceBytesStmt = db.prepare("SELECT COALESCE(SUM(total_bytes),0) total FROM skill_versions WHERE workspace_id = ?");
    this.sweep("pending_skill_content_rollbacks");
    this.sweep("pending_skill_content_deletes");
  }

  createSkill(workspaceId: WorkspaceId, displayTitle: string, bundle: ValidatedSkillBundle): SkillObject {
    const now = new Date().toISOString();
    const id = newSkillId();
    const version = newVersion();
    this.publish(workspaceId, { id, displayTitle, version, now, bundle, createOwner: true });
    return this.getSkill(workspaceId, id)!;
  }

  createVersion(workspaceId: WorkspaceId, skillId: string, bundle: ValidatedSkillBundle): SkillVersionObject {
    const owner = this.row(workspaceId, skillId);
    if (!owner) return undefined as never;
    if (owner.name !== bundle.name) throw invalidRequest("Skill name and directory are immutable across versions");
    const count = Number((this.db.prepare("SELECT COUNT(*) n FROM skill_versions WHERE workspace_id=? AND skill_id=?").get(workspaceId, skillId) as { n: number }).n);
    if (count >= this.maxVersions) throw invalidRequest(`Skill may retain at most ${this.maxVersions} versions`);
    const version = newVersion();
    this.publish(workspaceId, { id: skillId, displayTitle: owner.display_title, version, now: new Date().toISOString(), bundle, createOwner: false });
    return this.getVersion(workspaceId, skillId, version)!;
  }

  private publish(workspaceId: WorkspaceId, input: { id: string; displayTitle: string; version: string; now: string; bundle: ValidatedSkillBundle; createOwner: boolean }): void {
    const current = (this.workspaceBytesStmt.get(workspaceId) as { total: number }).total;
    if (current + input.bundle.totalBytes > this.maxWorkspaceBytes) throw invalidRequest("Workspace skill content quota exceeded");
    const objects = input.bundle.files.map((file) => ({ file, id: newSkillContentObjectId() }));
    withSqliteTransaction(this.db, () => {
      const stmt = this.db.prepare("INSERT INTO pending_skill_content_rollbacks VALUES (?,?,?)");
      for (const object of objects) stmt.run(workspaceId, object.id, input.now);
    });
    try {
      for (const object of objects) this.writeObject(object.id, object.file.bytes);
      withSqliteTransaction(this.db, () => {
        if (input.createOwner) {
          this.db.prepare("INSERT INTO skills VALUES (?,?,?,?,?,?,?,?)").run(workspaceId, input.id, input.bundle.name, input.displayTitle, "custom", input.version, input.now, input.now);
        } else {
          this.db.prepare("UPDATE skills SET latest_version=?,updated_at=? WHERE workspace_id=? AND id=?").run(input.version, input.now, workspaceId, input.id);
        }
        this.db.prepare("INSERT INTO skill_versions VALUES (?,?,?,?,?,?,?,?,?,?)").run(workspaceId, input.id, newSkillVersionId(), input.version, input.bundle.description, input.bundle.directory, input.bundle.files.length, input.bundle.totalBytes, input.bundle.manifestSha256, input.now);
        const fileStmt = this.db.prepare("INSERT INTO skill_files VALUES (?,?,?,?,?,?,?)");
        for (const object of objects) fileStmt.run(workspaceId, input.id, input.version, object.file.path, object.file.size, object.file.sha256, object.id);
        const clear = this.db.prepare("DELETE FROM pending_skill_content_rollbacks WHERE content_object_id=?");
        for (const object of objects) clear.run(object.id);
      });
    } catch (error) {
      this.sweep("pending_skill_content_rollbacks");
      throw normalizeConstraint(error);
    }
  }

  getSkill(workspaceId: WorkspaceId, skillId: string): SkillObject | undefined { const row = this.row(workspaceId, skillId); return row && toSkill(row); }
  listSkills(workspaceId: WorkspaceId, limit: number, after?: string): SkillPage<SkillObject> {
    const rows = this.db.prepare(`SELECT * FROM skills WHERE workspace_id=? ${after ? "AND id>?" : ""} ORDER BY id LIMIT ?`).all(...(after ? [workspaceId, after, limit + 1] : [workspaceId, limit + 1])) as unknown as SkillRow[];
    return page(rows, limit, toSkill, (row) => row.id);
  }
  getVersion(workspaceId: WorkspaceId, skillId: string, version: string): SkillVersionObject | undefined {
    const resolved = version === "latest" ? this.row(workspaceId, skillId)?.latest_version : version;
    if (!resolved) return undefined;
    const row = this.db.prepare("SELECT * FROM skill_versions WHERE workspace_id=? AND skill_id=? AND version=?").get(workspaceId, skillId, resolved) as unknown as VersionRow | undefined;
    const owner = this.row(workspaceId, skillId);
    return row && owner ? toVersion(row, owner.name) : undefined;
  }
  listVersions(workspaceId: WorkspaceId, skillId: string, limit: number, after?: string): SkillPage<SkillVersionObject> {
    const owner = this.row(workspaceId, skillId); if (!owner) return { data: [], has_more: false, next_page: null };
    const rows = this.db.prepare(`SELECT * FROM skill_versions WHERE workspace_id=? AND skill_id=? ${after ? "AND version>?" : ""} ORDER BY version LIMIT ?`).all(...(after ? [workspaceId, skillId, after, limit + 1] : [workspaceId, skillId, limit + 1])) as unknown as VersionRow[];
    return page(rows, limit, (row) => toVersion(row, owner.name), (row) => row.version);
  }

  deleteVersion(workspaceId: WorkspaceId, skillId: string, version: string): boolean {
    const row = this.db.prepare("SELECT version FROM skill_versions WHERE workspace_id=? AND skill_id=? AND version=?").get(workspaceId, skillId, version);
    if (!row) return false;
    const now = new Date().toISOString();
    withSqliteTransaction(this.db, () => {
      this.db.prepare("INSERT OR IGNORE INTO pending_skill_content_deletes SELECT workspace_id,content_object_id,? FROM skill_files WHERE workspace_id=? AND skill_id=? AND version=?").run(now, workspaceId, skillId, version);
      this.db.prepare("DELETE FROM skill_versions WHERE workspace_id=? AND skill_id=? AND version=?").run(workspaceId, skillId, version);
      const latest = this.db.prepare("SELECT version FROM skill_versions WHERE workspace_id=? AND skill_id=? ORDER BY version DESC LIMIT 1").get(workspaceId, skillId) as { version: string } | undefined;
      this.db.prepare("UPDATE skills SET latest_version=?,updated_at=? WHERE workspace_id=? AND id=?").run(latest?.version ?? null, now, workspaceId, skillId);
    });
    this.sweep("pending_skill_content_deletes"); return true;
  }
  deleteSkill(workspaceId: WorkspaceId, skillId: string): boolean {
    const owner = this.row(workspaceId, skillId); if (!owner) return false;
    const count = (this.db.prepare("SELECT COUNT(*) n FROM skill_versions WHERE workspace_id=? AND skill_id=?").get(workspaceId, skillId) as { n: number }).n;
    if (count > 0) throw invalidRequest("Skill versions must be deleted before deleting the skill");
    this.db.prepare("DELETE FROM skills WHERE workspace_id=? AND id=?").run(workspaceId, skillId); return true;
  }
  openContent(workspaceId: WorkspaceId, skillId: string, version: string, path: string): Uint8Array | undefined {
    const row = this.db.prepare("SELECT content_object_id FROM skill_files WHERE workspace_id=? AND skill_id=? AND version=? AND path=?").get(workspaceId, skillId, version, path) as { content_object_id: string } | undefined;
    if (!row) return undefined;
    if (this.memoryObjects !== undefined) return this.memoryObjects.get(row.content_object_id)?.slice();
    try { return new Uint8Array(readFileSync(this.objectPath(row.content_object_id))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  private row(workspaceId: WorkspaceId, id: string): SkillRow | undefined { return this.db.prepare("SELECT * FROM skills WHERE workspace_id=? AND id=?").get(workspaceId, id) as unknown as SkillRow | undefined; }
  private objectPath(id: string): string { if (this.objectsDir === undefined) throw new Error("Skill object path unavailable for memory store"); return resolve(this.objectsDir, id.slice(0, 2), id); }
  private writeObject(id: string, bytes: Uint8Array): void { if (this.memoryObjects !== undefined) { if (this.memoryObjects.has(id)) throw new Error(`Skill content object ${id} already exists`); this.memoryObjects.set(id, bytes.slice()); return; } const path = this.objectPath(id); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, bytes, { mode: 0o600, flag: "wx" }); }
  private sweep(table: "pending_skill_content_rollbacks" | "pending_skill_content_deletes"): void {
    const rows = this.db.prepare(`SELECT content_object_id FROM ${table}`).all() as unknown as Array<{ content_object_id: string }>;
    for (const row of rows) { if (this.memoryObjects !== undefined) this.memoryObjects.delete(row.content_object_id); else { try { unlinkSync(this.objectPath(row.content_object_id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue; } } this.db.prepare(`DELETE FROM ${table} WHERE content_object_id=?`).run(row.content_object_id); }
  }
  close(): void {}
}

export class InMemorySkillsStore extends SqliteSkillsStore {
  constructor(opts: { maxWorkspaceBytes?: number; maxVersions?: number } = {}) {
    super(new DatabaseSync(":memory:"), undefined, opts);
  }
  override close(): void { this.db.close(); }
}

function toSkill(row: SkillRow): SkillObject { return { id: row.id, display_title: row.display_title, latest_version: row.latest_version, source: "custom", type: "skill", created_at: row.created_at, updated_at: row.updated_at }; }
function toVersion(row: VersionRow, name: string): SkillVersionObject { return { id: row.id, skill_id: row.skill_id, version: row.version, name, description: row.description, directory: row.directory, type: "skill_version", created_at: row.created_at }; }
function page<R,T>(rows: R[], limit: number, map: (row:R)=>T, cursor:(row:R)=>string): SkillPage<T> { const dataRows=rows.slice(0,limit); return { data:dataRows.map(map), has_more:rows.length>limit, next_page:rows.length>limit ? cursor(dataRows[dataRows.length-1]!) : null }; }
function normalizeConstraint(error: unknown): unknown { const message = error instanceof Error ? error.message : ""; if (message.includes("skills.workspace_id, skills.display_title")) return invalidRequest("Skill cannot reuse an existing display_title"); if (message.includes("skills.workspace_id, skills.name")) return invalidRequest("Skill cannot reuse an existing name"); return error; }
