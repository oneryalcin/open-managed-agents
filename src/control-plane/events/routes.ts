import { Hono } from "hono";
import { parseJsonBody, parseLimit, parseOrder } from "../http.ts";
import { invalidRequest } from "../errors.ts";
import {
  requestFingerprint,
  validateIdempotencyKey,
} from "../request-idempotency.ts";
import { workspaceIdFrom, type ControlPlaneRouteEnv } from "../workspace.ts";
import type { AdmissionLimits } from "../admission.ts";
import type { SessionEventsService } from "./types.ts";
import { sseEventFrame } from "./sse.ts";

type AppEnv = ControlPlaneRouteEnv;

export function sessionEventsRoutes(
  service: SessionEventsService,
  admission?: AdmissionLimits,
): Hono<AppEnv> {
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
        workspaceIdFrom(c),
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
      return jsonResponse(
        response.body,
        response.status,
        c.get("requestId"),
        response.headers,
      );
    }
    const body = await parseJsonBody(c.req);
    return c.json(
      {
        data: service.send(workspaceIdFrom(c), sessionId, body, {
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
      service.list(workspaceIdFrom(c), sessionId, {
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
    // 0113 D9: the stream's cost is its lifetime (a bounded live queue per
    // subscription), so the slot is held until the stream closes.
    const releaseStream = admission?.sseStreams.acquire(workspaceIdFrom(c));
    const abortController = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => abortController.abort(), {
      once: true,
    });
    let events;
    try {
      events = service.stream(workspaceIdFrom(c), sessionId, {
        lastEventId: c.req.header("last-event-id"),
        signal: abortController.signal,
      });
    } catch (error) {
      releaseStream?.();
      throw error;
    }
    const requestId = c.get("requestId");
    return new Response(toSseBody(events, abortController, releaseStream), {
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

function parseJsonBytes(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw invalidRequest("Request body must be valid JSON", String(error));
  }
}

function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "request-id": requestId,
      ...extraHeaders,
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
  onClose?: () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    // Demand-gated on purpose: pull() runs only when the consumer has drained
    // the stream's internal queue, so a slow/stalled client suspends the
    // broadcaster iterator and its bounded live-queue overflow→refetch
    // protection holds. An eager start() loop here drains the broadcaster
    // into unbounded response/socket buffering (#127). A rejected pull()
    // errors the stream, matching the previous controller.error() path.
    async pull(controller) {
      let next;
      try {
        next = await iterator.next();
      } catch (error) {
        onClose?.();
        throw error;
      }
      if (next.done) {
        onClose?.();
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(sseEventFrame(next.value)));
    },
    async cancel() {
      onClose?.();
      abortController.abort();
      if (typeof iterator.return === "function") {
        await iterator.return();
      }
    },
  });
}
