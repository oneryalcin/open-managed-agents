import type { ManagedAgentsContentBlock } from "../../types/events.ts";
import { textFromContent } from "./runtime-helpers.ts";
import type { StoredConversationEntry, UnfinishedUserMessage } from "./types.ts";

// Plan 0147: which user messages were sent to Pi but never reached the saved
// conversation, because their turn did not settle (crash, hard error,
// ownership loss). The rebuilt session tells the model about them.

/** Custom message type of the note that reports unfinished turns. */
export const UNFINISHED_TURN_NOTE = "oma.unfinished_turn";

export interface CoverageTurn {
  state: string;
  triggerEventIds: readonly string[];
  closeReason: string | null;
}

export interface CoverageUserEvent {
  id: string;
  content: ManagedAgentsContentBlock[];
}

export function unfinishedUserMessages(input: {
  /** user.message events, in log order. */
  userEvents: readonly CoverageUserEvent[];
  turns: readonly CoverageTurn[];
  stored: readonly StoredConversationEntry[];
}): UnfinishedUserMessage[] {
  const turnByTrigger = new Map<string, CoverageTurn>();
  for (const turn of input.turns) {
    for (const eventId of turn.triggerEventIds) turnByTrigger.set(eventId, turn);
  }
  const storedUserTexts: string[] = [];
  const alreadyNoted = new Set<string>();
  for (const row of input.stored) {
    const entry = JSON.parse(row.json) as StoredEntryShape;
    if (entry.type === "message" && entry.message?.role === "user") {
      storedUserTexts.push(textOf(entry.message.content));
    }
    if (entry.type === "custom_message" && entry.customType === UNFINISHED_TURN_NOTE) {
      for (const id of entry.details?.eventIds ?? []) alreadyNoted.add(id);
    }
  }

  const unfinished: UnfinishedUserMessage[] = [];
  let next = 0;
  for (const event of input.userEvents) {
    // Only messages that started a turn reached Pi (image-only or blank
    // messages never do), as the text the runner sent.
    const turn = turnByTrigger.get(event.id);
    const text = textFromContent(event.content);
    if (turn === undefined || text === undefined) continue;
    // In order: steered messages sit in an earlier turn's checkpoint, so
    // matching by content, not by turn, keeps them covered.
    if (storedUserTexts[next] === text) {
      next += 1;
      continue;
    }
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
  message?: { role?: string; content?: unknown };
}

// Pi stores a user prompt as a single text block (or a plain string).
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}
