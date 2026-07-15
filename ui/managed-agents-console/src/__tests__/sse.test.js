import { describe, expect, it, vi } from "vitest";
import { SseFrameParser, followEventStream } from "../sse.js";

const encoder = new TextEncoder();

describe("SseFrameParser", () => {
  it("parses chunked CRLF frames and multi-line data", () => {
    const parser = new SseFrameParser();
    expect(parser.push("id: sevt_1\r\nevent: agent.message\r\nda")).toEqual([]);
    expect(parser.push("ta: {\"id\":\r\ndata: \"sevt_1\"}\r\n\r\n")).toEqual([{
      id: "sevt_1",
      type: "agent.message",
      data: "{\"id\":\n\"sevt_1\"}",
    }]);
  });

  it("rejects an oversized frame before unbounded buffering", () => {
    const parser = new SseFrameParser({ maxFrameBytes: 12 });
    expect(() => parser.push("data: 123456789\n")).toThrow("exceeds");
  });
});

describe("followEventStream", () => {
  it("authenticates, deduplicates replay, and resumes with Last-Event-ID", async () => {
    const controller = new AbortController();
    const calls = [];
    const first = response([
      'id: sevt_1\nevent: agent.message\ndata: {"id":"sevt_1","type":"agent.message"}\n\n',
    ]);
    const second = response([
      'id: sevt_1\nevent: agent.message\ndata: {"id":"sevt_1","type":"agent.message"}\n\n',
      'id: sevt_2\nevent: session.status_idle\ndata: {"id":"sevt_2","type":"session.status_idle"}\n\n',
    ]);
    const fetchImpl = vi.fn(async (_url, init) => {
      calls.push(init.headers);
      if (calls.length === 1) return first;
      return second;
    });
    const events = [];
    await followEventStream({
      url: "/stream",
      headers: { "x-api-key": "oma_test" },
      signal: controller.signal,
      fetchImpl,
      reconnectDelayMs: 0,
      onEvent: (event) => {
        events.push(event.id);
        if (event.id === "sevt_2") controller.abort();
      },
    });
    expect(calls[0]["x-api-key"]).toBe("oma_test");
    expect(calls[1]["last-event-id"]).toBe("sevt_1");
    expect(events).toEqual(["sevt_1", "sevt_2"]);
  });

  it("fails terminally on authentication errors without reconnecting", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 401 }));
    await expect(followEventStream({
      url: "/stream",
      headers: {},
      fetchImpl,
      onEvent: () => {},
    })).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("aborts an active reader and reports closed", async () => {
    const controller = new AbortController();
    const states = [];
    const body = new ReadableStream({
      start(streamController) {
        streamController.enqueue(encoder.encode(
          'id: sevt_1\ndata: {"id":"sevt_1"}\n\n',
        ));
      },
    });
    const done = followEventStream({
      url: "/stream",
      headers: {},
      signal: controller.signal,
      fetchImpl: async () => new Response(body, { status: 200, headers: { "content-type":"text/event-stream" } }),
      onEvent: () => controller.abort(),
      onState: (state) => states.push(state.status),
    });
    await done;
    expect(states).toEqual(["connected", "closed"]);
  });

  it("bounds reconnects when a successful response closes without an event", async () => {
    const fetchImpl = vi.fn(async () => response([]));
    await expect(followEventStream({
      url:"/stream",
      headers:{},
      fetchImpl,
      onEvent:() => {},
      reconnectDelayMs:0,
      maxReconnects:2,
    })).rejects.toThrow("stream closed");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rejects a 200 response that is not an event stream", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", {
      status:200,
      headers:{ "content-type":"application/json" },
    }));
    await expect(followEventStream({
      url:"/stream",
      headers:{},
      fetchImpl,
      onEvent:() => {},
    })).rejects.toThrow("unexpected content type");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function response(frames) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}
