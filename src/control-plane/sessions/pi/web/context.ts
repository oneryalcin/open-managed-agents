import type { EnvironmentStore } from "../../../environments/types.ts";
import { parseNetworkingConfig } from "../../../egress/policy.ts";
import type { SessionEventStore } from "../../../events/types.ts";
import type { SessionStore } from "../../types.ts";
import type { WorkspaceId } from "../../../workspace.ts";
import type { WebToolContext } from "./fetch-tool.ts";

// Plan 0149: what a web tool needs at call time, read fresh from the stores:
// the session environment's egress policy (environments are immutable, but a
// session may outlive an archived one) and the events the prior-context rule
// reads.

const PROVENANCE_EVENT_TYPES = [
  "user.message",
  "user.custom_tool_result",
  "agent.tool_use",
  "agent.tool_result",
] as const;

export function createStoreBackedWebToolContext(opts: {
  sessions: Pick<SessionStore, "retrieveAny">;
  environments: Pick<EnvironmentStore, "retrieveAny">;
  events: Pick<SessionEventStore, "listEventsOfTypes">;
}): (workspaceId: WorkspaceId, sessionId: string) => Promise<WebToolContext> {
  return async (workspaceId, sessionId) => {
    const session = opts.sessions.retrieveAny(workspaceId, sessionId);
    const environment = session === undefined
      ? undefined
      : opts.environments.retrieveAny(workspaceId, session.environment_id);
    let policy: WebToolContext["policy"];
    try {
      policy = environment === undefined ? undefined : parseNetworkingConfig(environment.config);
    } catch {
      policy = undefined; // an unparseable policy allows nothing
    }
    const events = opts.events
      .listEventsOfTypes(workspaceId, sessionId, PROVENANCE_EVENT_TYPES)
      .map((event) => ({
        id: event.id,
        type: event.type,
        processed_at: event.processed_at,
        payload: event.payload,
      }));
    return { policy, events };
  };
}
