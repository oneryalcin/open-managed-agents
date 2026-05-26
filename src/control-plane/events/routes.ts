import { Hono } from "hono";
import { parseJsonBody, parseLimit, parseOrder } from "../http.ts";
import { invalidRequest } from "../errors.ts";
import { DEFAULT_WORKSPACE_ID } from "../workspace.ts";
import type { SessionEventsService } from "./types.ts";

interface AppEnv {
  Variables: {
    requestId: string;
  };
}

export function sessionEventsRoutes(service: SessionEventsService): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/", async (c) => {
    const sessionId = requiredSessionId(c.req.param("sessionId"));
    const body = await parseJsonBody(c.req);
    return c.json(
      {
        data: service.send(DEFAULT_WORKSPACE_ID, sessionId, body),
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
    const events = service.stream(DEFAULT_WORKSPACE_ID, sessionId, {
      lastEventId: c.req.header("last-event-id"),
      signal: c.req.raw.signal,
    });
    const requestId = c.get("requestId");
    return new Response(toSseBody(events), {
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

function toSseBody(events: AsyncIterable<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          const id = String(event.id ?? "");
          const type = String(event.type ?? "message");
          const data = JSON.stringify(event);
          controller.enqueue(
            encoder.encode(`id: ${id}\nevent: ${type}\ndata: ${data}\n\n`),
          );
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
