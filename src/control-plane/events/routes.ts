import { createHash } from "node:crypto";
import { Hono } from "hono";
import { parseJsonBody, parseLimit, parseOrder } from "../http.ts";
import { invalidRequest } from "../errors.ts";
import { DEFAULT_WORKSPACE_ID } from "../workspace.ts";
import type { SessionEventsService } from "./types.ts";
import { sseEventFrame } from "./sse.ts";

interface AppEnv {
  Variables: {
    requestId: string;
  };
}

export function sessionEventsRoutes(service: SessionEventsService): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/", async (c) => {
    const sessionId = requiredSessionId(c.req.param("sessionId"));
    const idempotencyKey = c.req.header("idempotency-key");
    if (idempotencyKey !== undefined) {
      const rawBody = new Uint8Array(await c.req.raw.arrayBuffer());
      const body = parseJsonBytes(rawBody);
      const method = c.req.method.toUpperCase();
      const concretePath = new URL(c.req.url).pathname;
      const response = service.sendIdempotent(
        DEFAULT_WORKSPACE_ID,
        sessionId,
        body,
        {
          method,
          concretePath,
          key: validateIdempotencyKey(idempotencyKey),
          routeLabel: "POST /v1/sessions/{session_id}/events",
          fingerprintSha256: requestFingerprint(method, concretePath, rawBody),
        },
        {
          signal: c.req.raw.signal,
          requestId: c.get("requestId"),
        },
      );
      return jsonResponse(response.body, response.status, c.get("requestId"));
    }
    const body = await parseJsonBody(c.req);
    return c.json(
      {
        data: service.send(DEFAULT_WORKSPACE_ID, sessionId, body, {
          signal: c.req.raw.signal,
        }),
      },
      200,
    );
  });

  app.get("/", (c) => {
    const sessionId = requiredSessionId(c.req.param("sessionId"));
    const limit = parseLimit(c.req.query("limit"));
    const page = parsePage(c.req.query("page"));
    const order = parseOrder(c.req.query("order"));
    const types = parseTypesQuery(c.req.url);
    return c.json(
      service.list(DEFAULT_WORKSPACE_ID, sessionId, {
        ...(limit === undefined ? {} : { limit }),
        ...(page === undefined ? {} : { page }),
        ...(order === undefined ? {} : { order }),
        ...(types.length === 0 ? {} : { types }),
      }),
      200,
    );
  });

  app.get("/stream", (c) => {
    const sessionId = requiredSessionId(c.req.param("sessionId"));
    const abortController = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => abortController.abort(), {
      once: true,
    });
    const events = service.stream(DEFAULT_WORKSPACE_ID, sessionId, {
      lastEventId: c.req.header("last-event-id"),
      signal: abortController.signal,
    });
    const requestId = c.get("requestId");
    return new Response(toSseBody(events, abortController), {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "request-id": requestId,
      },
    });
  });

  return app;
}

function requiredSessionId(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw invalidRequest("Session ID path parameter is required");
  }
  return value;
}

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

function validateIdempotencyKey(value: string): string {
  if (value.length === 0) {
    throw invalidRequest("`Idempotency-Key` must not be empty");
  }
  if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw invalidRequest(
      `\`Idempotency-Key\` must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  if (!/^[\x21-\x7E]+$/.test(value)) {
    throw invalidRequest("`Idempotency-Key` must contain only visible ASCII characters");
  }
  return value;
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw invalidRequest("Request body must be valid JSON", String(error));
  }
}

function requestFingerprint(
  method: string,
  concretePath: string,
  rawBody: Uint8Array,
): string {
  const hash = createHash("sha256");
  hash.update(method);
  hash.update("\n");
  hash.update(concretePath);
  hash.update("\n");
  hash.update(rawBody);
  return hash.digest("hex");
}

function jsonResponse(body: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "request-id": requestId,
    },
  });
}

function parsePage(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (!value.startsWith("sevt_")) {
    throw invalidRequest("`page` must be a valid event cursor");
  }
  return value;
}

function parseTypesQuery(url: string): string[] {
  const params = new URL(url).searchParams;
  const values = params.getAll("types[]");
  return values.filter((value) => value.length > 0);
}

function toSseBody(
  events: AsyncIterable<Record<string, unknown>>,
  abortController: AbortController,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          const event = next.value;
          controller.enqueue(encoder.encode(sseEventFrame(event)));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      abortController.abort();
      if (typeof iterator.return === "function") {
        await iterator.return();
      }
    },
  });
}
