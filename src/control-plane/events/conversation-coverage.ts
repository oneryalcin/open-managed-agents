import type { ManagedAgentsContentBlock } from "../../types/events.ts";
import { textFromContent } from "./runtime-helpers.ts";
import type { StoredConversationEntry, UnfinishedUserMessage } from "./types.ts";

// Plan 0147: which user messages were sent to Pi but never reached the saved
// conversation, because their turn did not settle (crash, hard error,
// ownership loss). The rebuilt session tells the model about them.
//
// Coverage is by identity, not text: each saved checkpoint records the turns
// whose messages it includes (the settled turn and any steered into it), so
// repeated texts and send order cannot confuse it.

/** Custom message type of the note that reports unfinished turns. */
export const UNFINISHED_TURN_NOTE = "oma.unfinished_turn";

export interface CoverageTurn {
  turnId: string;
  state: string;
  triggerEventIds: readonly string[];
  closeReason: string | null;
}

export interface CoverageUserEvent {
  id: string;
  content: ManagedAgentsContentBlock[];
}

export function unfinishedUserMessages(input: {
  /** user.message events, in log order (only used to order the note). */
  userEvents: readonly CoverageUserEvent[];
  turns: readonly CoverageTurn[];
  /** Turns some saved checkpoint includes. */
  coveredTurnIds: ReadonlySet<string>;
  stored: readonly StoredConversationEntry[];
}): UnfinishedUserMessage[] {
  const turnByTrigger = new Map<string, CoverageTurn>();
  for (const turn of input.turns) {
    for (const eventId of turn.triggerEventIds) turnByTrigger.set(eventId, turn);
  }
  const alreadyNoted = new Set<string>();
  for (const row of input.stored) {
    const entry = JSON.parse(row.json) as StoredEntryShape;
    if (entry.type === "custom_message" && entry.customType === UNFINISHED_TURN_NOTE) {
      for (const id of entry.details?.eventIds ?? []) alreadyNoted.add(id);
    }
  }

  const unfinished: UnfinishedUserMessage[] = [];
  for (const event of input.userEvents) {
    // Only messages that started a turn reached Pi (image-only or blank
    // messages never do).
    const turn = turnByTrigger.get(event.id);
    const text = textFromContent(event.content);
    if (turn === undefined || text === undefined) continue;
    if (input.coveredTurnIds.has(turn.turnId)) continue;
    if (!isClosed(turn.state)) continue; // still pending: about to be delivered
    if (turn.closeReason === "interrupted") continue; // a deliberate interrupt
    if (alreadyNoted.has(event.id)) continue; // reported by an earlier rebuild
    unfinished.push({ eventId: event.id, text });
  }
  return unfinished;
}

function isClosed(state: string): boolean {
  return state === "completed" || state === "terminalized";
}

interface StoredEntryShape {
  type?: string;
  customType?: string;
  details?: { eventIds?: string[] };
}
