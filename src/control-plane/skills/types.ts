import type { WorkspaceId } from "../workspace.ts";

export const MAX_SKILL_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_SKILL_VERSION_BYTES = 100 * 1024 * 1024;
export const MAX_SKILL_FILES = 500;
export const DEFAULT_SKILLS_WORKSPACE_MAX_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_SKILLS_MAX_VERSIONS = 20;

export interface SkillObject {
  id: string;
  display_title: string;
  latest_version: string;
  source: "custom";
  type: "skill";
  created_at: string;
  updated_at: string;
}

export interface SkillVersionObject {
  id: string;
  skill_id: string;
  version: string;
  name: string;
  description: string;
  directory: string;
  type: "skill_version";
  created_at: string;
}

export interface SkillPage<T> {
  data: T[];
  has_more: boolean;
  next_page: string | null;
}

export interface ValidatedSkillFile {
  path: string;
  bytes: Uint8Array;
  size: number;
  sha256: string;
}

export interface ValidatedSkillBundle {
  name: string;
  description: string;
  directory: string;
  files: ValidatedSkillFile[];
  totalBytes: number;
  manifestSha256: string;
}

export interface SkillsStore {
  createSkill(workspaceId: WorkspaceId, displayTitle: string, bundle: ValidatedSkillBundle): SkillObject;
  createVersion(workspaceId: WorkspaceId, skillId: string, bundle: ValidatedSkillBundle): SkillVersionObject;
  getSkill(workspaceId: WorkspaceId, skillId: string): SkillObject | undefined;
  listSkills(workspaceId: WorkspaceId, limit: number, after?: string): SkillPage<SkillObject>;
  getVersion(workspaceId: WorkspaceId, skillId: string, version: string): SkillVersionObject | undefined;
  listVersions(workspaceId: WorkspaceId, skillId: string, limit: number, after?: string): SkillPage<SkillVersionObject>;
  deleteVersion(workspaceId: WorkspaceId, skillId: string, version: string): boolean;
  deleteSkill(workspaceId: WorkspaceId, skillId: string): boolean;
  openContent(workspaceId: WorkspaceId, skillId: string, version: string, path: string): Uint8Array | undefined;
  close?(): void;
}

export interface SkillsService {
  create(workspaceId: WorkspaceId, displayTitle: string | undefined, files: readonly { name: string; bytes: Uint8Array }[]): Promise<SkillObject>;
  createVersion(workspaceId: WorkspaceId, skillId: string, files: readonly { name: string; bytes: Uint8Array }[]): Promise<SkillVersionObject>;
  get(workspaceId: WorkspaceId, skillId: string): SkillObject;
  list(workspaceId: WorkspaceId, limit: number, after?: string): SkillPage<SkillObject>;
  getVersion(workspaceId: WorkspaceId, skillId: string, version: string): SkillVersionObject;
  listVersions(workspaceId: WorkspaceId, skillId: string, limit: number, after?: string): SkillPage<SkillVersionObject>;
  deleteVersion(workspaceId: WorkspaceId, skillId: string, version: string): { id: string; type: "skill_version_deleted" };
  delete(workspaceId: WorkspaceId, skillId: string): { id: string; type: "skill_deleted" };
}
