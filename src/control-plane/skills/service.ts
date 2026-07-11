import { invalidRequest, notFound } from "../errors.ts";
import type { WorkspaceId } from "../workspace.ts";
import { validateSkillUpload } from "./archive.ts";
import type { SkillsService, SkillsStore } from "./types.ts";

export class DefaultSkillsService implements SkillsService {
  constructor(private readonly store: SkillsStore) {}
  async create(workspaceId: WorkspaceId, displayTitle: string | undefined, files: readonly { name: string; bytes: Uint8Array }[]) {
    const bundle = await validateSkillUpload(files);
    const title = (displayTitle ?? bundle.name).trim();
    if (!title) throw invalidRequest("display_title must not be empty");
    return this.store.createSkill(workspaceId, title, bundle);
  }
  async createVersion(workspaceId: WorkspaceId, skillId: string, files: readonly { name: string; bytes: Uint8Array }[]) {
    this.get(workspaceId, skillId);
    return this.store.createVersion(workspaceId, skillId, await validateSkillUpload(files));
  }
  get(workspaceId: WorkspaceId, skillId: string) { const value=this.store.getSkill(workspaceId,skillId); if(!value) throw notFound(`Skill ${skillId} not found`); return value; }
  list(workspaceId: WorkspaceId, limit: number, after?: string) { return this.store.listSkills(workspaceId,limit,after); }
  getVersion(workspaceId: WorkspaceId, skillId: string, version: string) { const value=this.store.getVersion(workspaceId,skillId,version); if(!value) throw notFound(`Skill version ${version} not found`); return value; }
  listVersions(workspaceId: WorkspaceId, skillId: string, limit: number, after?: string) { this.get(workspaceId,skillId); return this.store.listVersions(workspaceId,skillId,limit,after); }
  deleteVersion(workspaceId: WorkspaceId, skillId: string, version: string) { if(!this.store.deleteVersion(workspaceId,skillId,version)) throw notFound(`Skill version ${version} not found`); return { id: version, type: "skill_version_deleted" as const }; }
  delete(workspaceId: WorkspaceId, skillId: string) { if(!this.store.deleteSkill(workspaceId,skillId)) throw notFound(`Skill ${skillId} not found`); return { id: skillId, type: "skill_deleted" as const }; }
}
