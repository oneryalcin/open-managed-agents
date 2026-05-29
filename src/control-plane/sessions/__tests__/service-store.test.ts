import { describe, expect, it } from "vitest";
import { SqliteAgentStore } from "../../agents/store.ts";
import { DefaultAgentService } from "../../agents/service.ts";
import { SqliteEnvironmentStore } from "../../environments/store.ts";
import { DefaultEnvironmentService } from "../../environments/service.ts";
import { DEFAULT_WORKSPACE_ID } from "../../workspace.ts";
import { DefaultSessionService } from "../service.ts";
import { SqliteSessionStore } from "../store.ts";
import { InMemoryFileStorage } from "../../files/store.ts";
import type { SessionStore } from "../types.ts";
import type {
  RuntimeEventRunner,
  RuntimeSessionPrepareOptions,
} from "../../events/types.ts";

const OTHER_WORKSPACE_ID = "wrk_other";

describe("session service/store", () => {
  it("keeps workspace rows isolated and does not leak workspace_id to wire responses", async () => {
    const fixture = createFixture();
    const firstAgent = fixture.createAgent(DEFAULT_WORKSPACE_ID, "Default Agent");
    const firstEnv = fixture.createEnvironment(DEFAULT_WORKSPACE_ID, "Default Env");
    const secondAgent = fixture.createAgent(OTHER_WORKSPACE_ID, "Other Agent");
    const secondEnv = fixture.createEnvironment(OTHER_WORKSPACE_ID, "Other Env");

    const first = await fixture.sessions.create(DEFAULT_WORKSPACE_ID, {
      agent: firstAgent.id,
      environment_id: firstEnv.id,
    });
    const second = await fixture.sessions.create(OTHER_WORKSPACE_ID, {
      agent: secondAgent.id,
      environment_id: secondEnv.id,
    });

    expect(first).not.toHaveProperty("workspace_id");
    expect(second).not.toHaveProperty("workspace_id");
    expect(fixture.sessions.list(DEFAULT_WORKSPACE_ID).data.map((s) => s.id)).toEqual([
      first.id,
    ]);
    expect(fixture.sessions.list(OTHER_WORKSPACE_ID).data.map((s) => s.id)).toEqual([
      second.id,
    ]);
  });

  it("treats an empty page cursor as an invalid direct store cursor", async () => {
    const fixture = createFixture();
    const agent = fixture.createAgent(DEFAULT_WORKSPACE_ID, "Default Agent");
    const environment = fixture.createEnvironment(DEFAULT_WORKSPACE_ID, "Default Env");

    await fixture.sessions.create(DEFAULT_WORKSPACE_ID, {
      agent: agent.id,
      environment_id: environment.id,
    });

    expect(fixture.sessionStore.list(DEFAULT_WORKSPACE_ID, { page: "" })).toEqual({
      data: [],
      has_more: false,
      next_page: null,
    });
  });

  it("archives sessions as terminated while keeping them retrievable by direct lookup", async () => {
    const fixture = createFixture();
    const agent = fixture.createAgent(DEFAULT_WORKSPACE_ID, "Default Agent");
    const environment = fixture.createEnvironment(DEFAULT_WORKSPACE_ID, "Default Env");
    const session = await fixture.sessions.create(DEFAULT_WORKSPACE_ID, {
      agent: agent.id,
      environment_id: environment.id,
    });

    const archived = fixture.sessionStore.archive(
      DEFAULT_WORKSPACE_ID,
      session.id,
      new Date().toISOString(),
    )!;

    expect(archived.id).toBe(session.id);
    expect(archived.status).toBe("terminated");
    expect(archived.archived_at).toEqual(expect.any(String));
    expect(fixture.sessions.retrieve(DEFAULT_WORKSPACE_ID, session.id).id).toBe(
      session.id,
    );
    expect(fixture.sessions.list(DEFAULT_WORKSPACE_ID).data).toEqual([]);
    expect(
      fixture.sessions.list(DEFAULT_WORKSPACE_ID, { includeArchived: true }).data
        .map((s) => s.id),
    ).toEqual([session.id]);
  });

  it("permanently deletes sessions", async () => {
    const fixture = createFixture();
    const agent = fixture.createAgent(DEFAULT_WORKSPACE_ID, "Default Agent");
    const environment = fixture.createEnvironment(DEFAULT_WORKSPACE_ID, "Default Env");
    const session = await fixture.sessions.create(DEFAULT_WORKSPACE_ID, {
      agent: agent.id,
      environment_id: environment.id,
    });

    await expect(fixture.sessions.delete(DEFAULT_WORKSPACE_ID, session.id)).resolves.toEqual({
      id: session.id,
      type: "session_deleted",
    });
    expect(() => fixture.sessions.retrieve(DEFAULT_WORKSPACE_ID, session.id))
      .toThrow("Session");
    expect(
      fixture.sessions.list(DEFAULT_WORKSPACE_ID, { includeArchived: true }).data,
    ).toEqual([]);
  });

  it("releases internal snapshot quota when deleting a session", async () => {
    const fixture = createFixture({ fileStorage: true });
    const agent = fixture.createAgent(DEFAULT_WORKSPACE_ID, "Default Agent");
    const environment = fixture.createEnvironment(DEFAULT_WORKSPACE_ID, "Default Env");
    const source = await fixture.fileStorage!.create(DEFAULT_WORKSPACE_ID, {
      filename: "probe.txt",
      mimeType: "text/plain",
      body: bytes("input"),
    });

    const session = await fixture.sessions.create(DEFAULT_WORKSPACE_ID, {
      agent: agent.id,
      environment_id: environment.id,
      resources: [{ type: "file", file_id: source.metadata.id }],
    });

    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(10);
    await fixture.sessions.delete(DEFAULT_WORKSPACE_ID, session.id);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(5);
  });

  it("cleans internal snapshots if session persistence fails", async () => {
    const fixture = createFixture({ fileStorage: true, failSessionCreate: true });
    const agent = fixture.createAgent(DEFAULT_WORKSPACE_ID, "Default Agent");
    const environment = fixture.createEnvironment(DEFAULT_WORKSPACE_ID, "Default Env");
    const source = await fixture.fileStorage!.create(DEFAULT_WORKSPACE_ID, {
      filename: "probe.txt",
      mimeType: "text/plain",
      body: bytes("input"),
    });

    await expect(
      fixture.sessions.create(DEFAULT_WORKSPACE_ID, {
        agent: agent.id,
        environment_id: environment.id,
        resources: [{ type: "file", file_id: source.metadata.id }],
      }),
    ).rejects.toThrow("injected session create failure");

    expect(fixture.sessionStore.list(DEFAULT_WORKSPACE_ID, { includeArchived: true }).data)
      .toEqual([]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(5);
  });

  it("cleans prepared runtime if persistence fails after materialization", async () => {
    const runtime = new FakeRuntimePreparer();
    const fixture = createFixture({
      fileStorage: true,
      failSessionCreate: true,
      runtime,
    });
    const agent = fixture.createAgent(DEFAULT_WORKSPACE_ID, "Default Agent");
    const environment = fixture.createEnvironment(DEFAULT_WORKSPACE_ID, "Default Env");
    const source = await fixture.fileStorage!.create(DEFAULT_WORKSPACE_ID, {
      filename: "probe.txt",
      mimeType: "text/plain",
      body: bytes("input"),
    });

    await expect(
      fixture.sessions.create(DEFAULT_WORKSPACE_ID, {
        agent: agent.id,
        environment_id: environment.id,
        resources: [{ type: "file", file_id: source.metadata.id }],
      }),
    ).rejects.toThrow("injected session create failure");

    expect(runtime.prepares).toHaveLength(1);
    expect(runtime.closed).toEqual([
      { workspaceId: DEFAULT_WORKSPACE_ID, sessionId: runtime.prepares[0]!.sessionId },
    ]);
    expect(fixture.sessionStore.list(DEFAULT_WORKSPACE_ID, { includeArchived: true }).data)
      .toEqual([]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(5);
  });

  it("materializes file resources before persisting the session row", async () => {
    const runtime = new FakeRuntimePreparer();
    const fixture = createFixture({ fileStorage: true, runtime });
    const agent = fixture.createAgent(DEFAULT_WORKSPACE_ID, "Default Agent");
    const environment = fixture.createEnvironment(DEFAULT_WORKSPACE_ID, "Default Env");
    const source = await fixture.fileStorage!.create(DEFAULT_WORKSPACE_ID, {
      filename: "probe.txt",
      mimeType: "text/plain",
      body: bytes("input"),
    });

    const session = await fixture.sessions.create(DEFAULT_WORKSPACE_ID, {
      agent: agent.id,
      environment_id: environment.id,
      resources: [{ type: "file", file_id: source.metadata.id }],
    });

    expect(runtime.prepares).toHaveLength(1);
    expect(runtime.prepares[0]).toMatchObject({
      workspaceId: DEFAULT_WORKSPACE_ID,
      sessionId: session.id,
    });
    expect(runtime.prepares[0]?.visibleDuringPrepare).toBe(false);
    expect(runtime.prepares[0]?.fileMounts).toEqual([
      expect.objectContaining({
        mountPath: `/mnt/session/uploads/${source.metadata.id}`,
        snapshotFileId: expect.stringMatching(/^file_/),
        sha256: source.sha256,
        sizeBytes: 5,
      }),
    ]);
  });

  it("does not prepare runtime for resource-free sessions", async () => {
    const runtime = new FakeRuntimePreparer();
    const fixture = createFixture({ runtime });
    const agent = fixture.createAgent(DEFAULT_WORKSPACE_ID, "Default Agent");
    const environment = fixture.createEnvironment(DEFAULT_WORKSPACE_ID, "Default Env");

    await fixture.sessions.create(DEFAULT_WORKSPACE_ID, {
      agent: agent.id,
      environment_id: environment.id,
    });

    expect(runtime.prepares).toEqual([]);
    expect(runtime.closed).toEqual([]);
  });

  it("cleans snapshots and prepared runtime if materialization fails", async () => {
    const runtime = new FakeRuntimePreparer({
      throwOnPrepare: new Error("materialization failed"),
    });
    const fixture = createFixture({ fileStorage: true, runtime });
    const agent = fixture.createAgent(DEFAULT_WORKSPACE_ID, "Default Agent");
    const environment = fixture.createEnvironment(DEFAULT_WORKSPACE_ID, "Default Env");
    const source = await fixture.fileStorage!.create(DEFAULT_WORKSPACE_ID, {
      filename: "probe.txt",
      mimeType: "text/plain",
      body: bytes("input"),
    });

    await expect(
      fixture.sessions.create(DEFAULT_WORKSPACE_ID, {
        agent: agent.id,
        environment_id: environment.id,
        resources: [{ type: "file", file_id: source.metadata.id }],
      }),
    ).rejects.toThrow("materialization failed");

    expect(fixture.sessionStore.list(DEFAULT_WORKSPACE_ID, { includeArchived: true }).data)
      .toEqual([]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(5);
    expect(runtime.closed).toEqual([{ workspaceId: DEFAULT_WORKSPACE_ID, sessionId: expect.any(String) }]);
  });

  it("enforces injectable session resource count and mounted-byte limits", async () => {
    const fixture = createFixture({
      fileStorage: true,
      maxFileResources: 2,
      maxMountedBytes: 6,
    });
    const agent = fixture.createAgent(DEFAULT_WORKSPACE_ID, "Default Agent");
    const environment = fixture.createEnvironment(DEFAULT_WORKSPACE_ID, "Default Env");
    const files = [];
    for (const name of ["a", "b", "c"]) {
      files.push(
        await fixture.fileStorage!.create(DEFAULT_WORKSPACE_ID, {
          filename: `${name}.txt`,
          mimeType: "text/plain",
          body: bytes("xxx"),
        }),
      );
    }

    await expect(
      fixture.sessions.create(DEFAULT_WORKSPACE_ID, {
        agent: agent.id,
        environment_id: environment.id,
        resources: files.map((file, index) => ({
          type: "file",
          file_id: file.metadata.id,
          mount_path: `${index}.txt`,
        })),
      }),
    ).rejects.toThrow("2 file limit");

    await expect(
      fixture.sessions.create(DEFAULT_WORKSPACE_ID, {
        agent: agent.id,
        environment_id: environment.id,
        resources: files.slice(0, 2).map((file, index) => ({
          type: "file",
          file_id: file.metadata.id,
          mount_path: `${index}.txt`,
        })),
      }),
    ).resolves.toMatchObject({
      resources: expect.arrayContaining([
        expect.objectContaining({ file_id: files[0]!.metadata.id }),
        expect.objectContaining({ file_id: files[1]!.metadata.id }),
      ]),
    });

    const tooLarge = await fixture.fileStorage!.create(DEFAULT_WORKSPACE_ID, {
      filename: "large.txt",
      mimeType: "text/plain",
      body: bytes("xxxxxxx"),
    });
    await expect(
      fixture.sessions.create(DEFAULT_WORKSPACE_ID, {
        agent: agent.id,
        environment_id: environment.id,
        resources: [{ type: "file", file_id: tooLarge.metadata.id }],
      }),
    ).rejects.toThrow("6 bytes mounted byte limit");
  });
});

function createFixture(
  opts: {
    fileStorage?: boolean;
    failSessionCreate?: boolean;
    maxFileResources?: number;
    maxMountedBytes?: number;
    runtime?: RuntimeEventRunner;
  } = {},
): {
  sessions: DefaultSessionService;
  sessionStore: SqliteSessionStore;
  fileStorage?: InMemoryFileStorage;
  createAgent(workspaceId: string, name: string): { id: string };
  createEnvironment(workspaceId: string, name: string): { id: string };
} {
  const agentStore = SqliteAgentStore.open(":memory:");
  const environmentStore = SqliteEnvironmentStore.open(":memory:");
  const sessionStore = SqliteSessionStore.open(":memory:");
  const agents = new DefaultAgentService(agentStore);
  const environments = new DefaultEnvironmentService(environmentStore);
  const fileStorage = opts.fileStorage ? new InMemoryFileStorage() : undefined;
  if (opts.runtime instanceof FakeRuntimePreparer) {
    opts.runtime.currentStore = sessionStore;
  }
  const serviceStore = opts.failSessionCreate
    ? failCreateStore(sessionStore)
    : sessionStore;
  const sessions = new DefaultSessionService(
    serviceStore,
    agentStore,
    environmentStore,
    fileStorage,
    {
      ...(opts.maxFileResources === undefined
        ? {}
        : { maxFileResources: opts.maxFileResources }),
      ...(opts.maxMountedBytes === undefined
        ? {}
        : { maxMountedBytes: opts.maxMountedBytes }),
      ...(opts.runtime === undefined ? {} : { runtime: opts.runtime }),
    },
  );

  return {
    sessions,
    sessionStore,
    ...(fileStorage === undefined ? {} : { fileStorage }),
    createAgent(workspaceId: string, name: string): { id: string } {
      return agents.create(workspaceId, {
        name,
        model: "claude-opus-4-7",
        tools: [{ type: "agent_toolset_20260401" }],
      });
    },
    createEnvironment(workspaceId: string, name: string): { id: string } {
      return environments.create(workspaceId, {
        name,
        config: { type: "cloud" },
      });
    },
  };
}

class FakeRuntimePreparer implements RuntimeEventRunner {
  readonly prepares: Array<{
    workspaceId: string;
    sessionId: string;
    visibleDuringPrepare: boolean;
    fileMounts: NonNullable<RuntimeSessionPrepareOptions["fileMounts"]>;
  }> = [];
  readonly closed: Array<{ workspaceId: string; sessionId: string }> = [];

  constructor(
    private readonly opts: {
      throwOnPrepare?: Error;
    } = {},
  ) {}

  prepareSession(
    workspaceId: string,
    sessionId: string,
    opts: RuntimeSessionPrepareOptions = {},
  ): void {
    this.prepares.push({
      workspaceId,
      sessionId,
      visibleDuringPrepare:
        this.currentStore?.retrieveAny(workspaceId, sessionId) !== undefined,
      fileMounts: opts.fileMounts ?? [],
    });
    if (this.opts.throwOnPrepare) throw this.opts.throwOnPrepare;
  }

  // Assigned by the fixture after construction so the fake can verify the
  // create path does not publish a half-materialized session row.
  currentStore: SqliteSessionStore | undefined;

  async *runUserMessage(): AsyncIterable<unknown> {}

  closeSession(workspaceId: string, sessionId: string): void {
    this.closed.push({ workspaceId, sessionId });
  }
}

function failCreateStore(delegate: SqliteSessionStore): SessionStore {
  return {
    create(): never {
      throw new Error("injected session create failure");
    },
    retrieve: delegate.retrieve.bind(delegate),
    retrieveAny: delegate.retrieveAny.bind(delegate),
    archive: delegate.archive.bind(delegate),
    delete: delegate.delete.bind(delegate),
    getFileMountSnapshots: delegate.getFileMountSnapshots.bind(delegate),
    list: delegate.list.bind(delegate),
    close: delegate.close.bind(delegate),
  };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
