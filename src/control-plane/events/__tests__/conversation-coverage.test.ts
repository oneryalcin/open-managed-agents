import { describe, expect, it } from "vitest";
import {
  UNFINISHED_TURN_NOTE,
  unfinishedUserMessages,
  type CoverageTurn,
  type CoverageUserEvent,
} from "../conversation-coverage.ts";
import type { StoredConversationEntry } from "../types.ts";

// Plan 0147: which dispatched user messages never reached the saved
// conversation, so the rebuilt model is told about them.

function userEvent(id: string, ...texts: string[]): CoverageUserEvent {
  return { id, content: texts.map((text) => ({ type: "text" as const, text })) };
}

function turn(trigger: string, state: string, closeReason: string | null = null): CoverageTurn {
  return { state, triggerEventIds: [trigger], closeReason };
}

function storedUser(id: string, text: string): StoredConversationEntry {
  return {
    entryId: id,
    json: JSON.stringify({ type: "message", id, message: { role: "user", content: [{ type: "text", text }] } }),
    turnId: "rtun",
    piVersion: "0.85.1",
  };
}

const ids = (result: ReturnType<typeof unfinishedUserMessages>) => result.map((m) => m.eventId);

describe("unfinished user messages", () => {
  it("reports a dispatched message whose closed turn never reached the conversation", () => {
    const result = unfinishedUserMessages({
      userEvents: [userEvent("a", "first"), userEvent("b", "second")],
      turns: [turn("a", "completed"), turn("b", "terminalized")],
      stored: [storedUser("u1", "first")],
    });

    expect(result).toEqual([{ eventId: "b", text: "second" }]);
  });

  it("treats a message steered into an earlier turn's checkpoint as covered", () => {
    const result = unfinishedUserMessages({
      userEvents: [userEvent("a", "first"), userEvent("b", "steered")],
      turns: [turn("a", "completed"), turn("b", "completed")],
      stored: [storedUser("u1", "first"), storedUser("u2", "steered")],
    });

    expect(ids(result)).toEqual([]);
  });

  it("does not report a deliberately interrupted turn", () => {
    const result = unfinishedUserMessages({
      userEvents: [userEvent("a", "stop me")],
      turns: [turn("a", "terminalized", "interrupted")],
      stored: [],
    });

    expect(ids(result)).toEqual([]);
  });

  it("does not report a turn that is still pending", () => {
    const result = unfinishedUserMessages({
      userEvents: [userEvent("a", "in flight")],
      turns: [turn("a", "running")],
      stored: [],
    });

    expect(ids(result)).toEqual([]);
  });

  it("ignores messages that never started a turn", () => {
    const result = unfinishedUserMessages({
      userEvents: [{ id: "img", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] as never }],
      turns: [],
      stored: [],
    });

    expect(ids(result)).toEqual([]);
  });

  it("matches multi-block messages by the text the runner sent", () => {
    const result = unfinishedUserMessages({
      userEvents: [userEvent("a", "line one", "line two")],
      turns: [turn("a", "completed")],
      stored: [storedUser("u1", "line one\nline two")],
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
      turns: [turn("a", "terminalized")],
      stored: [note],
    });

    expect(ids(result)).toEqual([]);
  });
});
