import type { ManagedAgentsSession } from "../../types/sessions.ts";
import { activeSeconds } from "../events/session-usage.ts";
import type { SessionEventStore } from "../events/types.ts";
import type { WorkspaceId } from "../workspace.ts";

/**
 * What a session response takes from the event store rather than the session
 * row: live status (#279), usage and active time (plan 0148).
 */
export type SessionRuntimeView = Pick<
  SessionEventStore,
  "latestSessionStatuses" | "sessionUsage"
>;

export function withRuntimeView(
  view: SessionRuntimeView,
  workspaceId: WorkspaceId,
  sessions: readonly ManagedAgentsSession[],
  now = new Date(),
): ManagedAgentsSession[] {
  if (sessions.length === 0) return [];
  const ids = sessions.map((session) => session.id);
  const statuses = view.latestSessionStatuses(workspaceId, ids);
  const usage = view.sessionUsage(workspaceId, ids);
  return sessions.map((session) => {
    const status = session.status === "terminated" ? undefined : statuses.get(session.id);
    const totals = usage.get(session.id);
    const until = session.archived_at === null ? now : new Date(session.archived_at);
    const active = totals === undefined ? 0 : activeSeconds(totals, until);
    return {
      ...session,
      ...(status === undefined ? {} : { status }),
      usage: {
        input_tokens: totals?.inputTokens ?? 0,
        output_tokens: totals?.outputTokens ?? 0,
        cache_read_input_tokens: totals?.cacheReadTokens ?? 0,
        cache_creation: totals === undefined || totals.spanCount === 0
          ? null
          : {
              ephemeral_1h_input_tokens: totals.cacheWrite1hTokens,
              ephemeral_5m_input_tokens: totals.cacheWriteTokens - totals.cacheWrite1hTokens,
            },
        active_seconds: active,
        list_cost: listCost(totals === undefined ? 0 : totals.costMicros),
        server_tool_use: null,
      },
      stats: { ...session.stats, active_seconds: active },
    };
  });
}

/** Cents, as hosted reports them; null when some request had no known price. */
function listCost(costMicros: number | null): { amount: string; currency: "USD" } | null {
  return costMicros === null
    ? null
    : { amount: String(Math.round(costMicros / 10_000)), currency: "USD" };
}
