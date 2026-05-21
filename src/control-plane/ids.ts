import { uuidv7 } from "../types/events.ts";

export function newAgentId(): string {
  return `agent_${uuidv7()}`;
}

export function newRequestId(): string {
  return `req_${uuidv7()}`;
}
