import { uuidv7 } from "../types/events.ts";

export function newAgentId(): string {
  return `agent_${uuidv7()}`;
}

export function newEnvironmentId(): string {
  return `env_${uuidv7()}`;
}

export function newFileId(): string {
  return `file_${uuidv7()}`;
}

export function newRequestId(): string {
  return `req_${uuidv7()}`;
}

export function newRuntimeTurnId(): string {
  return `rtun_${uuidv7()}`;
}

export function newSessionResourceId(): string {
  return `sesrsc_${uuidv7()}`;
}

export function newSessionId(): string {
  return `sesn_${uuidv7()}`;
}

export function newSecretId(): string {
  return `sec_${uuidv7()}`;
}

export function newSkillId(): string {
  return `skill_${uuidv7()}`;
}

export function newSkillVersionId(): string {
  return `skill_version_${uuidv7()}`;
}

export function newSkillContentObjectId(): string {
  return `skobj_${uuidv7()}`;
}

export function newVaultId(): string {
  return `vlt_${uuidv7()}`;
}

export function newVaultCredentialId(): string {
  return `vcrd_${uuidv7()}`;
}
