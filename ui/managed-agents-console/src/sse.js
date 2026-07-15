const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_RECONNECTS = 5;
const DEFAULT_RECONNECT_DELAY_MS = 250;

export class SseFrameParser {
  constructor({ maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
    this.maxFrameBytes = maxFrameBytes;
    this.buffer = "";
    this.eventType = "message";
    this.eventId = "";
    this.dataLines = [];
    this.frameBytes = 0;
  }

  push(text) {
    this.buffer += text;
    const events = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const event = this.consumeLine(line);
      if (event) events.push(event);
    }
    this.ensureBounded(this.buffer);
    return events;
  }

  consumeLine(line) {
    this.addFrameBytes(`${line}\n`);
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.eventType = value || "message";
    else if (field === "id" && !value.includes("\0")) this.eventId = value;
    else if (field === "data") this.dataLines.push(value);
    return null;
  }

  dispatch() {
    if (this.dataLines.length === 0) {
      this.resetFrame();
      return null;
    }
    const event = {
      id: this.eventId,
      type: this.eventType,
      data: this.dataLines.join("\n"),
    };
    this.resetFrame();
    return event;
  }

  addFrameBytes(value) {
    this.frameBytes += new TextEncoder().encode(value).byteLength;
    if (this.frameBytes > this.maxFrameBytes) {
      throw new Error("Session event stream frame exceeds the console limit");
    }
  }

  ensureBounded(value) {
    const pendingBytes = new TextEncoder().encode(value).byteLength;
    if (this.frameBytes + pendingBytes > this.maxFrameBytes) {
      throw new Error("Session event stream frame exceeds the console limit");
    }
  }

  resetFrame() {
    this.eventType = "message";
    this.eventId = "";
    this.dataLines = [];
    this.frameBytes = 0;
  }
}

export async function followEventStream({
  url,
  headers,
  signal,
  onEvent,
  onState = () => {},
  fetchImpl = fetch,
  lastEventId,
  maxReconnects = DEFAULT_MAX_RECONNECTS,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
}) {
  let cursor = lastEventId || null;
  let reconnects = 0;
  const seen = new Set();
  const seenOrder = [];

  while (!signal?.aborted) {
    const requestHeaders = { ...headers };
    if (cursor) requestHeaders["last-event-id"] = cursor;
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: requestHeaders,
        signal,
      });
      if (!response.ok) {
        const error = new Error(`Session event stream failed (${response.status})`);
        error.status = response.status;
        if (response.status < 500) throw terminal(error);
        throw error;
      }
      const contentType = response.headers?.get?.("content-type") ?? "";
      if (!contentType.toLowerCase().includes("text/event-stream")) {
        throw terminal(new Error("Session event stream returned an unexpected content type"));
      }
      if (!response.body) throw new Error("Session event stream returned no body");
      onState({ status: "connected", lastEventId: cursor });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseFrameParser({ maxFrameBytes });
      try {
        while (!signal?.aborted) {
          const next = await reader.read();
          if (next.done) break;
          const frames = parser.push(decoder.decode(next.value, { stream: true }));
          for (const frame of frames) {
            if (frame.id && seen.has(frame.id)) continue;
            let event;
            try {
              event = JSON.parse(frame.data);
            } catch {
              throw terminal(new Error("Session event stream returned invalid JSON"));
            }
            if (frame.id) {
              cursor = frame.id;
              rememberSeen(seen, seenOrder, frame.id);
            }
            await onEvent(event, { id: frame.id, type: frame.type });
            reconnects = 0;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (signal?.aborted) break;
      throw new Error("Session event stream closed");
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") break;
      if (error?.terminal || reconnects >= maxReconnects) {
        onState({ status: "failed", error, lastEventId: cursor });
        throw error;
      }
      reconnects += 1;
      onState({ status: "reconnecting", attempt: reconnects, error, lastEventId: cursor });
      await abortableDelay(reconnectDelayMs * reconnects, signal);
    }
  }
  onState({ status: "closed", lastEventId: cursor });
  return cursor;
}

function terminal(error) {
  error.terminal = true;
  return error;
}

function rememberSeen(seen, order, id) {
  seen.add(id);
  order.push(id);
  if (order.length > 2048) seen.delete(order.shift());
}

function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
