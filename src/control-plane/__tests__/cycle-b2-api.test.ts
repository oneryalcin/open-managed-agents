import { describe, expect, it } from "vitest";
import { createInMemoryControlPlaneApp } from "./helpers.ts";
import type { ApiErrorBody } from "../errors.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";

const VALID_AGENT = {
  name: "B2 Agent",
  model: "claude-opus-4-7",
  tools: [{ type: "agent_toolset_20260401" }],
};

const VALID_ENVIRONMENT = {
  name: "B2 Environment",
  config: {
    type: "cloud",
    networking: { type: "unrestricted" },
  },
};

describe("Cycle B.2 API", () => {
  it("sends supported user events and lists persisted history with public shape", async () => {
    const app = createInMemoryControlPlaneApp();
    const session = await setupSession(app);

    const sendRes = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "user.message",
            content: [
              { type: "text", text: "hello" },
              { type: "image", source: { kind: "url", value: "https://x/y.png" } },
            ],
          },
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: "ctu_1",
          },
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: "ctu_2",
            content: [{ type: "text", text: "done" }],
          },
          {
            type: "user.tool_confirmation",
            tool_use_id: "tu_1",
            result: "allow",
          },
          {
            type: "user.tool_confirmation",
            tool_use_id: "tu_2",
            result: "deny",
            deny_message: "not safe",
          },
        ],
      }),
    });
    expect(sendRes.status).toBe(200);
    expect(sendRes.headers.get("request-id")).toEqual(
      expect.stringMatching(/^req_/),
    );
    const sendBody = (await sendRes.json()) as { data: Array<Record<string, unknown>> };
    expect(sendBody.data).toHaveLength(5);
    expect(sendBody.data.map((event) => event.type)).toEqual([
      "user.message",
      "user.custom_tool_result",
      "user.custom_tool_result",
      "user.tool_confirmation",
      "user.tool_confirmation",
    ]);
    for (const event of sendBody.data) {
      expect(event.id).toEqual(expect.stringMatching(/^sevt_/));
      expect(event.processed_at).toEqual(expect.any(String));
      expect(event).not.toHaveProperty("session_id");
      expect(event).not.toHaveProperty("payload");
      expect(event).not.toHaveProperty("created_at");
    }

    const interruptRes = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.interrupt" }],
      }),
    });
    expect(interruptRes.status).toBe(200);
    const interruptBody = (await interruptRes.json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(interruptBody.data.map((event) => event.type)).toEqual([
      "user.interrupt",
    ]);
    const persistedEvents = [...sendBody.data, ...interruptBody.data];

    const listRes = await app.request(`/v1/sessions/${session.id}/events?order=asc`);
    expect(listRes.status).toBe(200);
    expect(listRes.headers.get("request-id")).toEqual(
      expect.stringMatching(/^req_/),
    );
    const listBody = (await listRes.json()) as {
      data: Array<Record<string, unknown>>;
      next_page: string | null;
    };
    expect(listBody.next_page).toBe(null);
    expect(listBody.data.map((event) => event.id)).toEqual(
      persistedEvents.map((event) => event.id),
    );
    expect(listBody.data.map((event) => event.processed_at)).toEqual(
      persistedEvents.map((event) => event.processed_at),
    );
    expect((listBody.data[0].content as Array<Record<string, unknown>>)[1]).toEqual({
      type: "image",
      source: { kind: "url", value: "https://x/y.png" },
    });
    for (const event of listBody.data) {
      expect(event).not.toHaveProperty("session_id");
      expect(event).not.toHaveProperty("payload");
      expect(event).not.toHaveProperty("created_at");
    }
  });

  it("preserves atomicity for multi-event sends", async () => {
    const app = createInMemoryControlPlaneApp();
    const session = await setupSession(app);

    await expectError(
      await app.request(`/v1/sessions/${session.id}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [
            { type: "user.message", content: [{ type: "text", text: "ok" }] },
            { type: "user.message", content: [] },
          ],
        }),
      }),
      400,
      "invalid_request_error",
      "`events[1].content` must be a non-empty array",
    );

    const listRes = await app.request(`/v1/sessions/${session.id}/events`);
    expect(listRes.status).toBe(200);
    await expect(listRes.json()).resolves.toEqual({ data: [], next_page: null });
  });

  it("supports list pagination for asc and desc, plus empty page handling", async () => {
    const app = createInMemoryControlPlaneApp();
    const session = await setupSession(app);
    await sendMessage(app, session.id, "one");
    await sendMessage(app, session.id, "two");
    await sendMessage(app, session.id, "three");

    const asc1 = await getEvents(app, `/v1/sessions/${session.id}/events?order=asc&limit=1`);
    const asc2 = await getEvents(
      app,
      `/v1/sessions/${session.id}/events?order=asc&limit=1&page=${asc1.next_page}`,
    );
    expect(asc1.data).toHaveLength(1);
    expect(asc2.data).toHaveLength(1);
    expect((asc1.data[0].id as string) < (asc2.data[0].id as string)).toBe(true);

    const desc1 = await getEvents(app, `/v1/sessions/${session.id}/events?order=desc&limit=1`);
    const desc2 = await getEvents(
      app,
      `/v1/sessions/${session.id}/events?order=desc&limit=1&page=${desc1.next_page}`,
    );
    expect(desc1.data).toHaveLength(1);
    expect(desc2.data).toHaveLength(1);
    expect((desc1.data[0].id as string) > (desc2.data[0].id as string)).toBe(true);

    const omitted = await getEvents(app, `/v1/sessions/${session.id}/events?limit=10`);
    const empty = await getEvents(app, `/v1/sessions/${session.id}/events?page=&limit=10`);
    expect(empty).toEqual(omitted);
  });

  it("supports types[] filtering including unknown types as empty results", async () => {
    const app = createInMemoryControlPlaneApp();
    const session = await setupSession(app);
    await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          { type: "user.message", content: [{ type: "text", text: "hello" }] },
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: "ctu_1",
            content: [{ type: "text", text: "ok" }],
          },
          {
            type: "user.tool_confirmation",
            tool_use_id: "tu_1",
            result: "allow",
          },
        ],
      }),
    });

    const single = await getEvents(
      app,
      `/v1/sessions/${session.id}/events?types[]=user.message`,
    );
    expect(single.data.map((event) => event.type)).toEqual(["user.message"]);

    const multi = await getEvents(
      app,
      `/v1/sessions/${session.id}/events?types[]=user.message&types[]=user.custom_tool_result&limit=1`,
    );
    expect(multi.data).toHaveLength(1);
    expect(multi.next_page).toEqual(expect.stringMatching(/^sevt_/));
    const multiNext = await getEvents(
      app,
      `/v1/sessions/${session.id}/events?types[]=user.message&types[]=user.custom_tool_result&limit=1&page=${multi.next_page}`,
    );
    expect(multiNext.data).toHaveLength(1);
    expect(multiNext.data.map((event) => event.type)).toEqual(["user.custom_tool_result"]);

    const unknown = await getEvents(
      app,
      `/v1/sessions/${session.id}/events?types[]=user.future_event`,
    );
    expect(unknown).toEqual({ data: [], next_page: null });

    const mixed = await getEvents(
      app,
      `/v1/sessions/${session.id}/events?types[]=user.message&types[]=user.future_event`,
    );
    expect(mixed.data.map((event) => event.type)).toEqual(["user.message"]);
  });

  it("rejects invalid send/list requests with public error envelope", async () => {
    const app = createInMemoryControlPlaneApp();
    const session = await setupSession(app);

    await expectError(
      await app.request(`/v1/sessions/${session.id}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      400,
      "invalid_request_error",
      "`events` must be a non-empty array",
    );

    await expectError(
      await app.request(`/v1/sessions/${session.id}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [{ type: "user.unknown" }],
        }),
      }),
      400,
      "invalid_request_error",
      "`events[0].type` must be one of user.message, user.interrupt, user.custom_tool_result, user.tool_confirmation",
    );

    await expectError(
      await app.request(`/v1/sessions/${session.id}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [
            {
              type: "user.custom_tool_result",
              tool_use_id: "wrong_field",
            },
          ],
        }),
      }),
      400,
      "invalid_request_error",
      "`events[0].custom_tool_use_id` must be a non-empty string",
    );

    await expectError(
      await app.request(`/v1/sessions/${session.id}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [
            {
              type: "user.tool_confirmation",
              tool_use_id: "tu_1",
              result: "allow",
              deny_message: "bad",
            },
          ],
        }),
      }),
      400,
      "invalid_request_error",
      "`events[0].deny_message` is only valid when result is `deny`",
    );

    await expectError(
      await app.request(`/v1/sessions/${session.id}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [
            {
              type: "user.message",
              session_id: session.id,
              content: [{ type: "text", text: "x" }],
            },
          ],
        }),
      }),
      400,
      "invalid_request_error",
      "`events[0].session_id` is not allowed; session ID comes from the URL path",
    );

    await expectError(
      await app.request(`/v1/sessions/${session.id}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{
          "events": [
            {
              "type": "user.message",
              "content": [{ "type": "chart", "value": 1e999 }]
            }
          ]
        }`,
      }),
      400,
      "invalid_request_error",
      "`events[0]` must be JSON-compatible",
    );

    await expectError(
      await app.request(`/v1/sessions/${session.id}/events?page=bad_cursor`),
      400,
      "invalid_request_error",
      "`page` must be a valid event cursor",
    );

    await expectError(
      await app.request(`/v1/sessions/${session.id}/events?order=sideways`),
      400,
      "invalid_request_error",
      "`order` must be `asc` or `desc`",
    );

    await expectError(
      await app.request(`/v1/sessions/${session.id}/events?limit=0`),
      400,
      "invalid_request_error",
      "`limit` must be a positive integer",
    );
  });

  it("rejects oversized event payloads and oversized event batches", async () => {
    const app = createInMemoryControlPlaneApp();
    const session = await setupSession(app);

    const giant = "x".repeat(70_000);
    await expectError(
      await app.request(`/v1/sessions/${session.id}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [
            {
              type: "user.message",
              content: [{ type: "text", text: giant }],
            },
          ],
        }),
      }),
      400,
      "invalid_request_error",
      "Serialized event payload exceeds 65536 bytes",
    );

    await expectError(
      await app.request(`/v1/sessions/${session.id}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: Array.from({ length: 201 }, () => ({
            type: "user.message",
            content: [{ type: "text", text: "x" }],
          })),
        }),
      }),
      400,
      "invalid_request_error",
      "`events` must contain at most 200 items",
    );
  });

  it("returns not_found_error for missing sessions and never leaks events cross-session", async () => {
    const app = createInMemoryControlPlaneApp();
    const first = await setupSession(app);
    const second = await setupSession(app);

    await sendMessage(app, first.id, "first");
    await sendMessage(app, second.id, "second");

    const firstList = await getEvents(app, `/v1/sessions/${first.id}/events`);
    expect(firstList.data).toHaveLength(1);
    expect(firstList.data[0].id).not.toBeUndefined();
    expect(firstList.data[0].content).toEqual([{ type: "text", text: "first" }]);
    const secondList = await getEvents(app, `/v1/sessions/${second.id}/events`);
    expect(firstList.data.some((event) => event.id === secondList.data[0]?.id)).toBe(
      false,
    );

    await expectError(
      await app.request("/v1/sessions/sesn_missing/events"),
      404,
      "not_found_error",
      "Session sesn_missing not found",
    );

    await expectError(
      await app.request("/v1/sessions/sesn_missing/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [{ type: "user.message", content: [{ type: "text", text: "x" }] }],
        }),
      }),
      404,
      "not_found_error",
      "Session sesn_missing not found",
    );
  });
});

async function setupSession(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
): Promise<ManagedAgentsSession> {
  const agent = await createAgent(app);
  const environment = await createEnvironment(app);
  return createSession(app, {
    agent: agent.id,
    environment_id: environment.id,
  });
}

async function sendMessage(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
  sessionId: string,
  text: string,
): Promise<void> {
  const res = await app.request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    }),
  });
  expect(res.status).toBe(200);
}

async function getEvents(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
  path: string,
): Promise<{ data: Array<Record<string, unknown>>; next_page: string | null }> {
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return (await res.json()) as { data: Array<Record<string, unknown>>; next_page: string | null };
}

async function createAgent(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
): Promise<ManagedAgentsAgent> {
  const res = await app.request("/v1/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(VALID_AGENT),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsAgent;
}

async function createEnvironment(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
): Promise<ManagedAgentsEnvironment> {
  const res = await app.request("/v1/environments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(VALID_ENVIRONMENT),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsEnvironment;
}

async function createSession(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
  body: unknown,
): Promise<ManagedAgentsSession> {
  const res = await app.request("/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsSession;
}

async function expectError(
  res: Response,
  status: number,
  type: ApiErrorBody["error"]["type"],
  message: string,
): Promise<void> {
  expect(res.status).toBe(status);
  const requestId = res.headers.get("request-id");
  expect(requestId).toEqual(expect.stringMatching(/^req_/));
  const body = (await res.json()) as ApiErrorBody;
  expect(body).toEqual({
    type: "error",
    error: { type, message },
    request_id: expect.stringMatching(/^req_/),
  });
  expect(body.request_id).toBe(requestId);
}
