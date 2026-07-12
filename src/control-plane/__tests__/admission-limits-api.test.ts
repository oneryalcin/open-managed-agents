import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";
import {
  createAdmissionLimits,
  parseAdmissionLimitsFromEnv,
  type AdmissionLimitsConfig,
} from "../admission.ts";
import { DefaultAgentService } from "../agents/service.ts";
import { SqliteAgentStore } from "../agents/store.ts";
import { DefaultEnvironmentService } from "../environments/service.ts";
import { SqliteEnvironmentStore } from "../environments/store.ts";
import { SessionEventBroadcaster } from "../events/broadcaster.ts";
import { DefaultSessionEventsService } from "../events/service.ts";
import { EventStore } from "../events/store.ts";
import { DefaultFileService } from "../files/service.ts";
import { InMemoryFileStorage } from "../files/store.ts";
import type { FileService } from "../files/types.ts";
import { DefaultSkillsService } from "../skills/service.ts";
import { InMemorySkillsStore } from "../skills/store.ts";
import type { SkillsService } from "../skills/types.ts";
import { DefaultSessionService } from "../sessions/service.ts";
import { SqliteSessionStore } from "../sessions/store.ts";
import type { ApiErrorBody } from "../errors.ts";
import { createRawControlPlaneApp, MANAGED_AGENTS_BETA } from "./helpers.ts";

const VALID_AGENT = {
  name: "Admission Agent",
  model: "claude-opus-4-7",
  tools: [{ type: "agent_toolset_20260401" }],
};

const VALID_ENVIRONMENT = {
  name: "Admission Environment",
  config: { type: "cloud", networking: { type: "unrestricted" } },
};

describe("admission limits config", () => {
  it("parses positive integers and leaves unset limits unlimited", () => {
    expect(parseAdmissionLimitsFromEnv({})).toEqual({});
    expect(
      parseAdmissionLimitsFromEnv({
        OMA_MAX_ACTIVE_SESSIONS_PER_WORKSPACE: "5",
        OMA_MAX_CONCURRENT_SSE_STREAMS: "100",
      }),
    ).toEqual({ maxActiveSessionsPerWorkspace: 5, maxConcurrentSseStreams: 100 });
  });

  it("rejects non-positive and non-integer values at construction", () => {
    for (const bad of ["0", "-1", "1.5", "many", ""]) {
      expect(() =>
        parseAdmissionLimitsFromEnv({ OMA_MAX_CONCURRENT_UPLOADS: bad }),
      ).toThrow(/OMA_MAX_CONCURRENT_UPLOADS must be a positive integer/);
    }
  });
});

describe("session admission", () => {
  it("returns 429 with retry-after at the cap and admits again after archive", async () => {
    const fixture = makeFixture({ maxActiveSessionsPerWorkspace: 1 });
    const body = await sessionCreateBody(fixture.app);
    const first = await request(fixture.app, "/v1/sessions", {
      method: "POST",
      body,
    });
    expect(first.status).toBe(200);
    const session = (await first.json()) as ManagedAgentsSession;

    const second = await request(fixture.app, "/v1/sessions", {
      method: "POST",
      body,
    });
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("1");
    const error = (await second.json()) as ApiErrorBody;
    expect(error.error.type).toBe("rate_limit_error");

    expect(
      (
        await request(fixture.app, `/v1/sessions/${session.id}/archive`, {
          method: "POST",
        })
      ).status,
    ).toBe(200);
    expect(
      (await request(fixture.app, "/v1/sessions", { method: "POST", body }))
        .status,
    ).toBe(200);
    fixture.close();
  });

  it("holds the cap for concurrent creates with file resources (async prep window)", async () => {
    // Row-count checks alone let every concurrent create pass before any row
    // inserts, because file-resource preparation awaits between the check and
    // the insert. The in-flight reservation must close that window.
    const fixture = makeFixture({ maxActiveSessionsPerWorkspace: 1 });
    const uploaded = await upload(fixture.app);
    expect(uploaded.status).toBe(200);
    const file = (await uploaded.json()) as { id: string };
    const base = await sessionCreateBody(fixture.app);
    const body = {
      ...base,
      resources: [{ type: "file", file_id: file.id, mount_path: "data.txt" }],
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(fixture.app, "/v1/sessions", { method: "POST", body }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 429, 429, 429, 429]);
    fixture.close();
  });

  it("releases the idempotency reservation on 429 so the same key succeeds later", async () => {
    const fixture = makeFixture({ maxActiveSessionsPerWorkspace: 1 });
    const body = await sessionCreateBody(fixture.app);
    const first = await request(fixture.app, "/v1/sessions", {
      method: "POST",
      body,
    });
    const session = (await first.json()) as ManagedAgentsSession;

    const capped = await request(fixture.app, "/v1/sessions", {
      method: "POST",
      body,
      headers: { "idempotency-key": "retry-me" },
    });
    expect(capped.status).toBe(429);

    await request(fixture.app, `/v1/sessions/${session.id}/archive`, {
      method: "POST",
    });
    // Same key, capacity freed: a completed 429 row would replay 429 forever.
    const retried = await request(fixture.app, "/v1/sessions", {
      method: "POST",
      body,
      headers: { "idempotency-key": "retry-me" },
    });
    expect(retried.status).toBe(200);
    fixture.close();
  });
});

describe("runtime turn admission", () => {
  it("rejects user.message sends at the pending-turn cap without persisting events", async () => {
    const fixture = makeFixture({ maxPendingRuntimeTurnsPerWorkspace: 1 });
    const session = await createSession(fixture.app);
    seedAcceptedTurn(fixture.eventStore, "wrk_default", session.id, "rtun_seed");

    const res = await request(
      fixture.app,
      `/v1/sessions/${session.id}/events`,
      { method: "POST", body: messageBody("over cap") },
    );
    expect(res.status).toBe(429);
    expect(((await res.json()) as ApiErrorBody).error.type).toBe(
      "rate_limit_error",
    );
    expect(fixture.eventStore.list("wrk_default", session.id)).toEqual([]);
    fixture.close();
  });

  it("admits messages that produce no runtime turn even at the cap", async () => {
    const fixture = makeFixture({ maxPendingRuntimeTurnsPerWorkspace: 1 });
    const session = await createSession(fixture.app);
    seedAcceptedTurn(fixture.eventStore, "wrk_default", session.id, "rtun_seed");

    // Whitespace-only text yields no prompt (textFromContent -> undefined),
    // so this message never accepts a turn and must not be capacity-rejected.
    const res = await request(
      fixture.app,
      `/v1/sessions/${session.id}/events`,
      { method: "POST", body: messageBody("   ") },
    );
    expect(res.status).toBe(200);
    fixture.close();
  });

  it("does not poison an idempotency key with a capped 429", async () => {
    const fixture = makeFixture({ maxPendingRuntimeTurnsPerWorkspace: 1 });
    const session = await createSession(fixture.app);
    seedAcceptedTurn(fixture.eventStore, "wrk_default", session.id, "rtun_seed");

    const first = await request(
      fixture.app,
      `/v1/sessions/${session.id}/events`,
      {
        method: "POST",
        body: messageBody("attempt one"),
        headers: { "idempotency-key": "turn-key" },
      },
    );
    expect(first.status).toBe(429);
    // A different body under the same key: a completed or stuck reservation
    // would surface as fingerprint mismatch or replay; a released one
    // re-executes and hits the cap again.
    const second = await request(
      fixture.app,
      `/v1/sessions/${session.id}/events`,
      {
        method: "POST",
        body: messageBody("attempt two"),
        headers: { "idempotency-key": "turn-key" },
      },
    );
    expect(second.status).toBe(429);
    fixture.close();
  });
});

describe("upload admission", () => {
  it("caps concurrent uploads per workspace and frees the slot when done", async () => {
    const gate = deferred();
    const fixture = makeFixture(
      { maxConcurrentUploadsPerWorkspace: 1 },
      { files: slowFileService(gate.promise) },
    );

    const inFlight = upload(fixture.app);
    await tick();
    const rejected = await upload(fixture.app);
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("1");

    gate.resolve();
    expect((await inFlight).status).toBe(200);
    gate.resolve();
    expect((await upload(fixture.app)).status).toBe(200);
    fixture.close();
  });

  it("rejects a capped upload before reading any of the request body", async () => {
    // Hono's bodyLimit eagerly buffers bodies without a content-length, so
    // the admission gate must run before it — a rejected upload must not
    // pull a single chunk from the socket.
    const gate = deferred();
    const fixture = makeFixture(
      { maxConcurrentUploadsPerWorkspace: 1 },
      { files: slowFileService(gate.promise) },
    );
    const inFlight = upload(fixture.app);
    await tick();

    let reads = 0;
    const countingBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const rejected = await fixture.app.request("/v1/files", {
      method: "POST",
      headers: {
        "anthropic-beta": MANAGED_AGENTS_BETA,
        "content-type": "multipart/form-data; boundary=x",
      },
      body: countingBody,
      duplex: "half",
    } as RequestInit);
    expect(rejected.status).toBe(429);
    // undici primes one chunk when constructing the Request; the server side
    // must not drain the stream. Ungated, bodyLimit's eager loop pulls
    // thousands of chunks (until 24 MiB) before rejecting with 413.
    expect(reads).toBeLessThanOrEqual(1);

    gate.resolve();
    expect((await inFlight).status).toBe(200);
    fixture.close();
  });

  it("returns 529 Overloaded at the process-wide upload cap", async () => {
    const gate = deferred();
    const fixture = makeFixture(
      { maxConcurrentUploads: 1 },
      { files: slowFileService(gate.promise) },
    );
    const inFlight = upload(fixture.app);
    await tick();
    const rejected = await upload(fixture.app);
    expect(rejected.status).toBe(529);
    const error = (await rejected.json()) as ApiErrorBody;
    expect(error.error).toEqual({ type: "overloaded_error", message: "Overloaded" });
    gate.resolve();
    await inFlight;
    fixture.close();
  });

  it("applies the upload admission gate to skill creation", async () => {
    const gate = deferred();
    const fixture = makeFixture(
      { maxConcurrentUploadsPerWorkspace: 1 },
      { skills: slowSkillsService(gate.promise) },
    );
    const inFlight = uploadSkill(fixture.app, "first-skill");
    await tick();
    const rejected = await uploadSkill(fixture.app, "second-skill");
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("1");
    gate.resolve();
    expect((await inFlight).status).toBe(200);
    fixture.close();
  });
});

describe("SSE stream admission", () => {
  it("caps concurrent streams per workspace and frees the slot on disconnect", async () => {
    const fixture = makeFixture({ maxConcurrentSseStreamsPerWorkspace: 1 });
    const session = await createSession(fixture.app);
    const path = `/v1/sessions/${session.id}/events/stream`;

    const first = await request(fixture.app, path);
    expect(first.status).toBe(200);
    const reader = first.body!.getReader();

    const rejected = await request(fixture.app, path);
    expect(rejected.status).toBe(429);
    expect(((await rejected.json()) as ApiErrorBody).error.type).toBe(
      "rate_limit_error",
    );

    await reader.cancel();
    const readmitted = await request(fixture.app, path);
    expect(readmitted.status).toBe(200);
    await readmitted.body!.getReader().cancel();
    fixture.close();
  });

  it("does not leak the slot when the stream request fails after admission", async () => {
    const fixture = makeFixture({ maxConcurrentSseStreamsPerWorkspace: 1 });
    // Nonexistent session: service.stream throws after the slot was acquired.
    expect(
      (await request(fixture.app, "/v1/sessions/sesn_ghost/events/stream"))
        .status,
    ).toBe(404);
    const session = await createSession(fixture.app);
    const ok = await request(
      fixture.app,
      `/v1/sessions/${session.id}/events/stream`,
    );
    expect(ok.status).toBe(200);
    await ok.body!.getReader().cancel();
    fixture.close();
  });
});

function makeFixture(
  config: AdmissionLimitsConfig,
  overrides: { files?: FileService; skills?: SkillsService } = {},
) {
  const db = new DatabaseSync(":memory:");
  const agentStore = new SqliteAgentStore(db);
  const environmentStore = new SqliteEnvironmentStore(db);
  const sessionStore = new SqliteSessionStore(db);
  const eventStore = new EventStore(db);
  const fileStorage = new InMemoryFileStorage();
  const broadcaster = new SessionEventBroadcaster(eventStore);
  const admission = createAdmissionLimits(config);
  const app = createRawControlPlaneApp({
    agents: new DefaultAgentService(agentStore, undefined),
    environments: new DefaultEnvironmentService(environmentStore),
    files: overrides.files ?? new DefaultFileService(fileStorage),
    skills: overrides.skills,
    sessions: new DefaultSessionService(
      sessionStore,
      agentStore,
      environmentStore,
      fileStorage,
      {
        assertDeletable: () => {},
        idempotencyLedger: eventStore,
        createSessionRowsWithIdempotency:
          sessionStore.createAndCompleteIdempotency.bind(sessionStore),
        ...(config.maxActiveSessionsPerWorkspace === undefined
          ? {}
          : {
              maxActiveSessionsPerWorkspace:
                config.maxActiveSessionsPerWorkspace,
            }),
      },
    ),
    sessionEvents: new DefaultSessionEventsService(
      eventStore,
      sessionStore,
      broadcaster,
      undefined,
      config.maxPendingRuntimeTurnsPerWorkspace === undefined
        ? {}
        : {
            maxPendingRuntimeTurnsPerWorkspace:
              config.maxPendingRuntimeTurnsPerWorkspace,
          },
    ),
    admission,
  });
  return { app, eventStore, admission, close: () => db.close() };
}

type Fixture = ReturnType<typeof makeFixture>;

function request(
  app: Fixture["app"],
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "anthropic-beta": MANAGED_AGENTS_BETA,
    ...opts.headers,
  };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(
    app.request(path, {
      method: opts.method ?? "GET",
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
  );
}

async function sessionCreateBody(app: Fixture["app"]) {
  const agentRes = await request(app, "/v1/agents", {
    method: "POST",
    body: VALID_AGENT,
  });
  const agent = (await agentRes.json()) as ManagedAgentsAgent;
  const envRes = await request(app, "/v1/environments", {
    method: "POST",
    body: VALID_ENVIRONMENT,
  });
  const environment = (await envRes.json()) as ManagedAgentsEnvironment;
  return { agent: agent.id, environment_id: environment.id };
}

async function createSession(app: Fixture["app"]): Promise<ManagedAgentsSession> {
  const res = await request(app, "/v1/sessions", {
    method: "POST",
    body: await sessionCreateBody(app),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsSession;
}

function messageBody(text: string): unknown {
  return {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  };
}

function upload(app: Fixture["app"]): Promise<Response> {
  const form = new FormData();
  form.append("file", new File(["payload"], "a.txt", { type: "text/plain" }));
  return Promise.resolve(
    app.request("/v1/files", {
      method: "POST",
      headers: { "anthropic-beta": MANAGED_AGENTS_BETA },
      body: form,
    }),
  );
}

function uploadSkill(app: Fixture["app"], name: string): Promise<Response> {
  const form = new FormData();
  form.append(
    "files[]",
    new File([`---\nname: ${name}\ndescription: admission\n---\n`], `${name}/SKILL.md`),
  );
  return Promise.resolve(
    app.request("/v1/skills", {
      method: "POST",
      headers: { "anthropic-beta": MANAGED_AGENTS_BETA },
      body: form,
    }),
  );
}

function slowFileService(gatePromise: Promise<void>): FileService {
  const inner = new DefaultFileService(new InMemoryFileStorage());
  return {
    ...inner,
    list: inner.list.bind(inner),
    retrieveMetadata: inner.retrieveMetadata.bind(inner),
    download: inner.download.bind(inner),
    delete: inner.delete.bind(inner),
    upload: async (workspaceId, input) => {
      await gatePromise;
      return inner.upload(workspaceId, input);
    },
  } as FileService;
}

function slowSkillsService(gatePromise: Promise<void>): SkillsService {
  const inner = new DefaultSkillsService(new InMemorySkillsStore());
  return {
    create: async (workspaceId, displayTitle, files) => {
      await gatePromise;
      return inner.create(workspaceId, displayTitle, files);
    },
    createVersion: inner.createVersion.bind(inner),
    get: inner.get.bind(inner),
    list: inner.list.bind(inner),
    getVersion: inner.getVersion.bind(inner),
    listVersions: inner.listVersions.bind(inner),
    deleteVersion: inner.deleteVersion.bind(inner),
    delete: inner.delete.bind(inner),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => (resolve = res));
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((res) => setTimeout(res, 10));
}

function seedAcceptedTurn(
  eventStore: EventStore,
  workspaceId: string,
  sessionId: string,
  turnId: string,
): void {
  const now = new Date().toISOString();
  eventStore.appendBatchWithRuntimeChanges([], {
    acceptedTurns: [
      {
        workspaceId,
        sessionId,
        turnId,
        ownerId: "owner-test",
        ownerGeneration: 1,
        leaseExpiresAt: now,
        triggerEventIds: [],
        now,
      },
    ],
  });
}
