import { describe, expect, it } from "vitest";
import { createInMemoryControlPlaneApp } from "../app.ts";
import type {
  RuntimeCustomToolUseEvent,
  RuntimeEventRunner,
} from "../events/types.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import type { ManagedAgentsUserCustomToolResultEventInput } from "../../types/events.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";

const VALID_AGENT = {
  name: "Interrupt Agent",
  model: "claude-opus-4-7",
  tools: [{ type: "agent_toolset_20260401" }],
};

const VALID_ENVIRONMENT = {
  name: "Interrupt Environment",
  config: {
    type: "cloud",
    networking: { type: "unrestricted" },
  },
};

describe("session user.interrupt API", () => {
  it("accepts, echoes, and persists user.interrupt without runtime", async () => {
    const app = createInMemoryControlPlaneApp();
    const session = await setupSession(app);

    const interrupt = await sendInterrupt(app, session.id);

    expect(interrupt.data.map((event) => event.type)).toEqual(["user.interrupt"]);
    expect(interrupt.data[0].id).toEqual(expect.stringMatching(/^sevt_/));
    expect(interrupt.data[0].processed_at).toEqual(expect.any(String));

    const listed = await listEvents(app, session.id);
    expect(listed.data.map((event) => event.type)).toEqual(["user.interrupt"]);
  });

  it("interrupts active runtime without closing or terminating the session", async () => {
    const runner = new InterruptTrackingRunner();
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: () => [] },
    });
    const session = await setupSession(app);

    await sendMessage(app, session.id, "start");
    await runner.started;

    await sendInterrupt(app, session.id);

    expect(runner.interrupted).toEqual([session.id]);
    expect(runner.closed).toEqual([]);

    runner.release();
    await waitFor(() => runner.completed === 1);

    const afterInterrupt = await getSession(app, session.id);
    expect(afterInterrupt.status).toBe("idle");
    expect(afterInterrupt.archived_at).toBe(null);

    await sendMessage(app, session.id, "after");
    await waitFor(() => runner.messages.length === 2);
    expect(runner.messages).toEqual(["start", "after"]);
  });

  it("accepts repeated interrupts on an idle session without starting a message run", async () => {
    const runner = new InterruptTrackingRunner();
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: () => [] },
    });
    const session = await setupSession(app);

    await sendInterrupt(app, session.id);
    await sendInterrupt(app, session.id);

    expect(runner.interrupted).toEqual([session.id, session.id]);
    expect(runner.messages).toEqual([]);
    expect(runner.closed).toEqual([]);
  });

  it("rejects user.interrupt for archived or deleted sessions", async () => {
    const app = createInMemoryControlPlaneApp();
    const archivedSession = await setupSession(app);
    const deletedSession = await setupSession(app);

    const archiveRes = await app.request(
      `/v1/sessions/${archivedSession.id}/archive`,
      { method: "POST" },
    );
    expect(archiveRes.status).toBe(200);
    const deleteRes = await app.request(`/v1/sessions/${deletedSession.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);

    for (const sessionId of [archivedSession.id, deletedSession.id]) {
      const res = await app.request(`/v1/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [{ type: "user.interrupt" }] }),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        error: {
          type: "not_found_error",
          message: `Session ${sessionId} not found`,
        },
      });
    }
  });

  it("rejects batches that mix user.interrupt and user.message before side effects", async () => {
    const runner = new InterruptTrackingRunner();
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: () => [] },
    });
    const session = await setupSession(app);

    for (const events of [
      [
        { type: "user.interrupt" },
        { type: "user.message", content: [{ type: "text", text: "replace" }] },
      ],
      [
        { type: "user.message", content: [{ type: "text", text: "start" }] },
        { type: "user.interrupt" },
      ],
    ]) {
      const res = await app.request(`/v1/sessions/${session.id}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message:
            "`events` cannot mix user.interrupt and user.message in one request",
        },
      });
    }

    const listed = await listEvents(app, session.id);
    expect(listed.data).toEqual([]);
    expect(runner.messages).toEqual([]);
    expect(runner.interrupted).toEqual([]);
  });

  it("rejects custom_tool_result after interrupt retires the pending custom tool", async () => {
    const runner = new InterruptibleCustomToolRunner();
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: () => [] },
    });
    const session = await setupSession(app);

    await sendMessage(app, session.id, "ask");
    await waitFor(() => runner.boundCustomToolUseId !== undefined);
    const customToolUseId = runner.boundCustomToolUseId;
    if (!customToolUseId) throw new Error("custom tool use id was not bound");

    await sendInterrupt(app, session.id);

    const staleResult = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: customToolUseId,
            content: [{ type: "text", text: "too late" }],
          },
        ],
      }),
    });

    expect(staleResult.status).toBe(404);
    expect(await staleResult.json()).toMatchObject({
      error: {
        type: "not_found_error",
        message: `No pending custom tool call: ${customToolUseId}`,
      },
    });
  });

  it("rejects custom_tool_result after interrupt in the same event batch", async () => {
    const runner = new InterruptibleCustomToolRunner();
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: () => [] },
    });
    const session = await setupSession(app);

    await sendMessage(app, session.id, "ask");
    await waitFor(() => runner.boundCustomToolUseId !== undefined);
    const customToolUseId = runner.boundCustomToolUseId;
    if (!customToolUseId) throw new Error("custom tool use id was not bound");

    const staleResult = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          { type: "user.interrupt" },
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: customToolUseId,
            content: [{ type: "text", text: "too late" }],
          },
        ],
      }),
    });

    expect(staleResult.status).toBe(404);
    expect(await staleResult.json()).toMatchObject({
      error: {
        type: "not_found_error",
        message: `No pending custom tool call: ${customToolUseId}`,
      },
    });

    await sendInterrupt(app, session.id);
  });

  it("honors custom_tool_result before interrupt in the same event batch", async () => {
    const runner = new InterruptibleCustomToolRunner();
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: () => [] },
    });
    const session = await setupSession(app);

    await sendMessage(app, session.id, "ask");
    await waitFor(() => runner.boundCustomToolUseId !== undefined);
    const customToolUseId = runner.boundCustomToolUseId;
    if (!customToolUseId) throw new Error("custom tool use id was not bound");

    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: customToolUseId,
            content: [{ type: "text", text: "done" }],
          },
          { type: "user.interrupt" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data.map((event) => event.type)).toEqual([
      "user.custom_tool_result",
      "user.interrupt",
    ]);
  });
});

class InterruptTrackingRunner implements RuntimeEventRunner {
  readonly messages: string[] = [];
  readonly interrupted: string[] = [];
  readonly closed: string[] = [];
  completed = 0;
  private markStarted: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });
  private resume: (() => void) | undefined;

  async *runUserMessage(
    _workspaceId: string,
    _sessionId: string,
    text: string,
  ): AsyncIterable<unknown> {
    this.messages.push(text);
    this.markStarted?.();
    await new Promise<void>((resolve) => {
      this.resume = resolve;
    });
    this.completed += 1;
  }

  interruptSession(_workspaceId: string, sessionId: string): void {
    this.interrupted.push(sessionId);
  }

  closeSession(_workspaceId: string, sessionId: string): void {
    this.closed.push(sessionId);
  }

  release(): void {
    this.resume?.();
  }
}

class InterruptibleCustomToolRunner implements RuntimeEventRunner {
  boundCustomToolUseId: string | undefined;
  private resolveResult: (() => void) | undefined;
  private pending = false;

  async *runUserMessage(): AsyncIterable<unknown> {
    yield { type: "agent_start" };
    this.pending = true;
    const result = new Promise<void>((resolve) => {
      this.resolveResult = resolve;
    });
    yield {
      type: "oma.custom_tool_use",
      piToolCallId: "toolu_interruptible",
      name: "ask_user",
      input: { question: "continue?" },
      bindCustomToolUseId: (id) => {
        this.boundCustomToolUseId = id;
      },
      rejectCustomToolUse: () => {
        this.pending = false;
        this.resolveResult?.();
      },
    } satisfies RuntimeCustomToolUseEvent;
    await result;
    yield { type: "agent_end", messages: [], willRetry: false };
  }

  claimCustomToolResult(
    _workspaceId: string,
    _sessionId: string,
    event: ManagedAgentsUserCustomToolResultEventInput,
  ): (() => void) | undefined {
    if (!this.pending || event.custom_tool_use_id !== this.boundCustomToolUseId) {
      return undefined;
    }
    return () => {
      this.pending = false;
      this.resolveResult?.();
    };
  }

  interruptSession(): void {
    this.pending = false;
    this.resolveResult?.();
  }

  customToolNames(): ReadonlySet<string> {
    return new Set(["ask_user"]);
  }
}

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

async function getSession(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
  sessionId: string,
): Promise<ManagedAgentsSession> {
  const res = await app.request(`/v1/sessions/${sessionId}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsSession;
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

async function sendInterrupt(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
  sessionId: string,
): Promise<{ data: Array<Record<string, unknown>> }> {
  const res = await app.request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [{ type: "user.interrupt" }] }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { data: Array<Record<string, unknown>> };
}

async function listEvents(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
  sessionId: string,
): Promise<{ data: Array<Record<string, unknown>>; next_page: string | null }> {
  const res = await app.request(`/v1/sessions/${sessionId}/events?order=asc`);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    data: Array<Record<string, unknown>>;
    next_page: string | null;
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1_000) {
      throw new Error("timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
