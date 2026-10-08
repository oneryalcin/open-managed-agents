import { describe, expect, it } from "vitest";
import {
  UNFINISHED_TURN_NOTE,
  unfinishedUserMessages,
  type CoverageTurn,
  type CoverageUserEvent,
} from "../conversation-coverage.ts";
import type { StoredConversationEntry } from "../types.ts";

// Plan 0147: which dispatched user messages never reached the saved
// conversation, by turn identity (each checkpoint records the turns it covers).

function userEvent(id: string, text: string): CoverageUserEvent {
  return { id, content: [{ type: "text" as const, text }] };
}

function turn(turnId: string, trigger: string, state: string, closeReason: string | null = null): CoverageTurn {
  return { turnId, state, triggerEventIds: [trigger], closeReason };
}

const ids = (result: ReturnType<typeof unfinishedUserMessages>) => result.map((m) => m.eventId);

describe("unfinished user messages", () => {
  it("reports a message whose closed turn no checkpoint covers", () => {
    const result = unfinishedUserMessages({
      userEvents: [userEvent("a", "first"), userEvent("b", "second")],
      turns: [turn("ta", "a", "completed"), turn("tb", "b", "terminalized")],
      coveredTurnIds: new Set(["ta"]),
      stored: [],
    });

    expect(result).toEqual([{ eventId: "b", text: "second" }]);
  });

  it("tells a lost message from an identical one that completed", () => {
    const result = unfinishedUserMessages({
      userEvents: [userEvent("lost", "Deploy"), userEvent("done", "Deploy")],
      turns: [turn("t1", "lost", "terminalized"), turn("t2", "done", "completed")],
      coveredTurnIds: new Set(["t2"]),
      stored: [],
    });

    expect(ids(result)).toEqual(["lost"]);
  });

  it("treats a message steered into a covered run as covered", () => {
    const result = unfinishedUserMessages({
      userEvents: [userEvent("a", "first"), userEvent("b", "steered")],
      turns: [turn("ta", "a", "completed"), turn("tb", "b", "completed")],
      coveredTurnIds: new Set(["ta", "tb"]),
      stored: [],
    });

    expect(ids(result)).toEqual([]);
  });

  it("does not report a deliberately interrupted turn", () => {
    const result = unfinishedUserMessages({
      userEvents: [userEvent("a", "stop me")],
      turns: [turn("ta", "a", "terminalized", "interrupted")],
      coveredTurnIds: new Set(),
      stored: [],
    });

    expect(ids(result)).toEqual([]);
  });

  it("does not report a turn that is still pending", () => {
    const result = unfinishedUserMessages({
      userEvents: [userEvent("a", "in flight")],
      turns: [turn("ta", "a", "running")],
      coveredTurnIds: new Set(),
      stored: [],
    });

    expect(ids(result)).toEqual([]);
  });

  it("ignores messages that never started a turn", () => {
    const result = unfinishedUserMessages({
      userEvents: [userEvent("img", "ignored: no turn")],
      turns: [],
      coveredTurnIds: new Set(),
      stored: [],
    });

    expect(ids(result)).toEqual([]);
  });

  it("does not report a message an earlier rebuild already noted", () => {
    const note: StoredConversationEntry = {
      entryId: "oma-note",
      json: JSON.stringify({
        type: "custom_message",
        id: "oma-note",
        customType: UNFINISHED_TURN_NOTE,
        details: { eventIds: ["a"] },
      }),
      turnId: "rtun",
      piVersion: "0.85.1",
    };

    const result = unfinishedUserMessages({
      userEvents: [userEvent("a", "lost")],
      turns: [turn("ta", "a", "terminalized")],
      coveredTurnIds: new Set(),
      stored: [note],
    });

    expect(ids(result)).toEqual([]);
  });
});
