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

export function newSessionId(): string {
  return `sesn_${uuidv7()}`;
}
