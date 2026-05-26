import { describe, expect, it } from "vitest";
import { sseEventFrame } from "../sse.ts";

describe("sseEventFrame", () => {
  it("formats id, event, and data lines with SSE frame terminator", () => {
    const frame = sseEventFrame({
      id: "sevt_abc",
      type: "user.message",
      payload: { content: [{ type: "text", text: "hello" }] },
    });

    expect(frame).toBe(
      "id: sevt_abc\nevent: user.message\ndata: {\"id\":\"sevt_abc\",\"type\":\"user.message\",\"payload\":{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}\n\n",
    );
  });

  it("falls back to empty id and message event type", () => {
    const frame = sseEventFrame({ payload: { ok: true } });
    expect(frame).toContain("id: \n");
    expect(frame).toContain("event: message\n");
    expect(frame).toContain("data: {\"payload\":{\"ok\":true}}\n\n");
  });
});

