import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteAgentStore } from "../../agents/store.ts";
import { DefaultAgentService } from "../../agents/service.ts";
import { SqliteEnvironmentStore } from "../../environments/store.ts";
import { DefaultEnvironmentService } from "../../environments/service.ts";
import { DEFAULT_WORKSPACE_ID } from "../../workspace.ts";
import { DefaultSessionService } from "../service.ts";
import { SqliteSessionStore } from "../store.ts";
import { InMemoryFileStorage } from "../../files/store.ts";
import type { SessionFileMountSnapshotRow, SessionStore } from "../types.ts";
import type {
  RuntimeEventRunner,
  RuntimeSessionPrepareOptions,
} from "../../events/types.ts";

const OTHER_WORKSPACE_ID = "wrk_other";

describe("session service/store", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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

  it("rejects invalid pending snapshot cleanup retry caps", () => {
    expect(() => createFixture({ pendingSnapshotCleanupMaxAttempts: 0 })).toThrow(
      "pendingSnapshotCleanupMaxAttempts must be at least 1",
    );
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
    expect(
      fixture.sessionStore.getPendingInternalSnapshotDeletes(DEFAULT_WORKSPACE_ID),
    ).toEqual([]);
  });

  it("queues internal snapshot cleanup when hard-delete storage deletion fails", async () => {
    const fileStorage = new FaultyInternalSnapshotDeleteStorage();
    const fixture = createFixture({ fileStorage });
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
    const snapshot = fixture.sessionStore.getFileMountSnapshots(
      DEFAULT_WORKSPACE_ID,
      session.id,
    )[0]!;
    fileStorage.failDeletesFor.add(snapshot.snapshot_file_id);

    await expect(fixture.sessions.delete(DEFAULT_WORKSPACE_ID, session.id)).resolves.toEqual({
      id: session.id,
      type: "session_deleted",
    });

    expect(() => fixture.sessions.retrieve(DEFAULT_WORKSPACE_ID, session.id))
      .toThrow("Session");
    expect(fixture.sessionStore.getFileMountSnapshots(DEFAULT_WORKSPACE_ID, session.id))
      .toEqual([]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(10);
    expect(
      fixture.sessionStore.getPendingInternalSnapshotDeletes(DEFAULT_WORKSPACE_ID, session.id),
    ).toEqual([
      expect.objectContaining({
        workspace_id: DEFAULT_WORKSPACE_ID,
        session_id: session.id,
        resource_id: snapshot.resource_id,
        snapshot_file_id: snapshot.snapshot_file_id,
        attempt_count: 1,
        last_attempt_at: expect.any(String),
        last_error: "injected snapshot delete failure",
      }),
    ]);

    fileStorage.failDeletesFor.clear();
    await fixture.sessions.sweepPendingInternalSnapshotDeletes(
      DEFAULT_WORKSPACE_ID,
      session.id,
    );
    expect(
      fixture.sessionStore.getPendingInternalSnapshotDeletes(DEFAULT_WORKSPACE_ID, session.id),
    ).toEqual([]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(5);
  });

  it("clears successful snapshot deletes while keeping failed siblings queued", async () => {
    const fileStorage = new FaultyInternalSnapshotDeleteStorage();
    const fixture = createFixture({ fileStorage });
    const agent = fixture.createAgent(DEFAULT_WORKSPACE_ID, "Default Agent");
    const environment = fixture.createEnvironment(DEFAULT_WORKSPACE_ID, "Default Env");
    const firstSource = await fixture.fileStorage!.create(DEFAULT_WORKSPACE_ID, {
      filename: "first.txt",
      mimeType: "text/plain",
      body: bytes("first"),
    });
    const secondSource = await fixture.fileStorage!.create(DEFAULT_WORKSPACE_ID, {
      filename: "second.txt",
      mimeType: "text/plain",
      body: bytes("second"),
    });
    const session = await fixture.sessions.create(DEFAULT_WORKSPACE_ID, {
      agent: agent.id,
      environment_id: environment.id,
      resources: [
        {
          type: "file",
          file_id: firstSource.metadata.id,
          mount_path: "first.txt",
        },
        {
          type: "file",
          file_id: secondSource.metadata.id,
          mount_path: "second.txt",
        },
      ],
    });
    const snapshots = fixture.sessionStore.getFileMountSnapshots(
      DEFAULT_WORKSPACE_ID,
      session.id,
    );
    const failedSnapshot = snapshots[0]!;
    const successfulSnapshot = snapshots[1]!;
    fileStorage.failDeletesFor.add(failedSnapshot.snapshot_file_id);

    await fixture.sessions.delete(DEFAULT_WORKSPACE_ID, session.id);

    expect(
      fixture.sessionStore.getPendingInternalSnapshotDeletes(DEFAULT_WORKSPACE_ID, session.id),
    ).toEqual([
      expect.objectContaining({
        resource_id: failedSnapshot.resource_id,
        snapshot_file_id: failedSnapshot.snapshot_file_id,
        attempt_count: 1,
      }),
    ]);
    expect(
      fixture.fileStorage!.getInternalRecordForTest(
        successfulSnapshot.snapshot_file_id,
      ),
    ).toBeUndefined();
    expect(
      fixture.fileStorage!.getInternalRecordForTest(failedSnapshot.snapshot_file_id),
    ).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({ id: failedSnapshot.snapshot_file_id }),
      }),
    );
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(16);
  });

  it("retries pending internal snapshot deletes during normal uptime", async () => {
    vi.useFakeTimers();
    const fileStorage = new FaultyInternalSnapshotDeleteStorage();
    const fixture = createFixture({
      fileStorage,
      pendingSnapshotCleanupRetryDelayMs: 25,
    });
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
    const snapshot = fixture.sessionStore.getFileMountSnapshots(
      DEFAULT_WORKSPACE_ID,
      session.id,
    )[0]!;
    fileStorage.failDeletesFor.add(snapshot.snapshot_file_id);

    await fixture.sessions.delete(DEFAULT_WORKSPACE_ID, session.id);
    expect(
      fixture.sessionStore.getPendingInternalSnapshotDeletes(DEFAULT_WORKSPACE_ID, session.id),
    ).toEqual([expect.objectContaining({ attempt_count: 1 })]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(10);

    fileStorage.failDeletesFor.clear();
    await vi.advanceTimersByTimeAsync(25);

    expect(
      fixture.sessionStore.getPendingInternalSnapshotDeletes(DEFAULT_WORKSPACE_ID, session.id),
    ).toEqual([]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(5);
  });

  it("stops automatic pending internal snapshot delete retries at the cap", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fileStorage = new FaultyInternalSnapshotDeleteStorage();
    const fixture = createFixture({
      fileStorage,
      pendingSnapshotCleanupRetryDelayMs: 25,
      pendingSnapshotCleanupMaxAttempts: 1,
    });
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
    const snapshot = fixture.sessionStore.getFileMountSnapshots(
      DEFAULT_WORKSPACE_ID,
      session.id,
    )[0]!;
    fileStorage.failDeletesFor.add(snapshot.snapshot_file_id);

    await fixture.sessions.delete(DEFAULT_WORKSPACE_ID, session.id);

    expect(
      fixture.sessionStore.getPendingInternalSnapshotDeletes(DEFAULT_WORKSPACE_ID, session.id),
    ).toEqual([expect.objectContaining({ attempt_count: 1 })]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(10);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Pending internal snapshot delete reached retry cap",
      expect.objectContaining({
        workspaceId: DEFAULT_WORKSPACE_ID,
        sessionId: session.id,
        resourceId: snapshot.resource_id,
        snapshotFileId: snapshot.snapshot_file_id,
        attemptCount: 1,
        maxAttempts: 1,
        error: "injected snapshot delete failure",
      }),
    );

    fileStorage.failDeletesFor.clear();
    await vi.advanceTimersByTimeAsync(25);

    expect(
      fixture.sessionStore.getPendingInternalSnapshotDeletes(DEFAULT_WORKSPACE_ID, session.id),
    ).toEqual([expect.objectContaining({ attempt_count: 1 })]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(10);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("applies the pending internal snapshot delete retry cap across service restart", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fileStorage = new FaultyInternalSnapshotDeleteStorage();
    const fixture = createFixture({
      fileStorage,
      pendingSnapshotCleanupMaxAttempts: 2,
    });
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
    const snapshot = fixture.sessionStore.getFileMountSnapshots(
      DEFAULT_WORKSPACE_ID,
      session.id,
    )[0]!;
    fileStorage.failDeletesFor.add(snapshot.snapshot_file_id);

    await fixture.sessions.delete(DEFAULT_WORKSPACE_ID, session.id);
    expect(
      fixture.sessionStore.getPendingInternalSnapshotDeletes(DEFAULT_WORKSPACE_ID, session.id),
    ).toEqual([expect.objectContaining({ attempt_count: 1 })]);
    expect(warn).not.toHaveBeenCalledWith(
      "Pending internal snapshot delete reached retry cap",
      expect.anything(),
    );

    const restarted = new DefaultSessionService(
      fixture.sessionStore,
      fixture.agentStore,
      fixture.environmentStore,
      fixture.fileStorage,
      { pendingSnapshotCleanupMaxAttempts: 2 },
    );
    await restarted.drainStartupSnapshotSweepsForTest();

    expect(
      fixture.sessionStore.getPendingInternalSnapshotDeletes(DEFAULT_WORKSPACE_ID, session.id),
    ).toEqual([expect.objectContaining({ attempt_count: 2 })]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(10);
    expect(warn).toHaveBeenCalledWith(
      "Pending internal snapshot delete reached retry cap",
      expect.objectContaining({
        workspaceId: DEFAULT_WORKSPACE_ID,
        sessionId: session.id,
        resourceId: snapshot.resource_id,
        snapshotFileId: snapshot.snapshot_file_id,
        attemptCount: 2,
        maxAttempts: 2,
        error: "injected snapshot delete failure",
      }),
    );
  });

  it("skips capped pending internal snapshot delete siblings during later sweeps", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fileStorage = new FaultyInternalSnapshotDeleteStorage();
    const fixture = createFixture({
      fileStorage,
      pendingSnapshotCleanupMaxAttempts: 2,
    });
    const agent = fixture.createAgent(DEFAULT_WORKSPACE_ID, "Default Agent");
    const environment = fixture.createEnvironment(DEFAULT_WORKSPACE_ID, "Default Env");
    const firstSource = await fixture.fileStorage!.create(DEFAULT_WORKSPACE_ID, {
      filename: "first.txt",
      mimeType: "text/plain",
      body: bytes("first"),
    });
    const secondSource = await fixture.fileStorage!.create(DEFAULT_WORKSPACE_ID, {
      filename: "second.txt",
      mimeType: "text/plain",
      body: bytes("second"),
    });
    const session = await fixture.sessions.create(DEFAULT_WORKSPACE_ID, {
      agent: agent.id,
      environment_id: environment.id,
      resources: [
        { type: "file", file_id: firstSource.metadata.id, mount_path: "first.txt" },
        { type: "file", file_id: secondSource.metadata.id, mount_path: "second.txt" },
      ],
    });
    const [firstSnapshot, secondSnapshot] = fixture.sessionStore
      .getFileMountSnapshots(DEFAULT_WORKSPACE_ID, session.id);
    fileStorage.failDeletesFor.add(firstSnapshot!.snapshot_file_id);
    fileStorage.failDeletesFor.add(secondSnapshot!.snapshot_file_id);

    await fixture.sessions.delete(DEFAULT_WORKSPACE_ID, session.id);
    fixture.sessionStore.recordPendingInternalSnapshotDeleteAttempt(
      DEFAULT_WORKSPACE_ID,
      session.id,
      firstSnapshot!.resource_id,
      new Date().toISOString(),
      "manually capped for test",
    );
    warn.mockClear();

    await fixture.sessions.sweepPendingInternalSnapshotDeletes(
      DEFAULT_WORKSPACE_ID,
      session.id,
    );

    expect(
      fixture.sessionStore.getPendingInternalSnapshotDeletes(DEFAULT_WORKSPACE_ID, session.id),
    ).toEqual([
      expect.objectContaining({
        resource_id: firstSnapshot!.resource_id,
        attempt_count: 2,
      }),
      expect.objectContaining({
        resource_id: secondSnapshot!.resource_id,
        attempt_count: 2,
      }),
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Pending internal snapshot delete reached retry cap",
      expect.objectContaining({
        resourceId: secondSnapshot!.resource_id,
        snapshotFileId: secondSnapshot!.snapshot_file_id,
        attemptCount: 2,
      }),
    );
  });

  it("startup sweep recovers pending internal snapshot deletes after a crash window", async () => {
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

    fixture.sessionStore.delete(DEFAULT_WORKSPACE_ID, session.id);
    expect(
      fixture.sessionStore.getPendingInternalSnapshotDeletes(DEFAULT_WORKSPACE_ID, session.id),
    ).toHaveLength(1);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(10);

    const restarted = new DefaultSessionService(
      fixture.sessionStore,
      fixture.agentStore,
      fixture.environmentStore,
      fixture.fileStorage,
    );
    await restarted.drainStartupSnapshotSweepsForTest();

    expect(
      fixture.sessionStore.getPendingInternalSnapshotDeletes(DEFAULT_WORKSPACE_ID, session.id),
    ).toEqual([]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(5);
  });

  it("clears pending internal snapshot deletes when storage is already absent", async () => {
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
    const snapshot = fixture.sessionStore.getFileMountSnapshots(
      DEFAULT_WORKSPACE_ID,
      session.id,
    )[0]!;

    fixture.sessionStore.delete(DEFAULT_WORKSPACE_ID, session.id);
    await fixture.fileStorage!.deleteInternalSnapshot(
      DEFAULT_WORKSPACE_ID,
      snapshot.snapshot_file_id,
    );
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(5);

    await fixture.sessions.sweepPendingInternalSnapshotDeletes(
      DEFAULT_WORKSPACE_ID,
      session.id,
    );

    expect(
      fixture.sessionStore.getPendingInternalSnapshotDeletes(DEFAULT_WORKSPACE_ID, session.id),
    ).toEqual([]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(5);
  });

  it("does not sweep another workspace's pending internal snapshot deletes", async () => {
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

    fixture.sessionStore.delete(DEFAULT_WORKSPACE_ID, session.id);
    await fixture.sessions.sweepPendingInternalSnapshotDeletes(OTHER_WORKSPACE_ID);

    expect(
      fixture.sessionStore.getPendingInternalSnapshotDeletes(DEFAULT_WORKSPACE_ID, session.id),
    ).toHaveLength(1);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(10);

    await fixture.sessions.sweepPendingInternalSnapshotDeletes(DEFAULT_WORKSPACE_ID);
    expect(
      fixture.sessionStore.getPendingInternalSnapshotDeletes(DEFAULT_WORKSPACE_ID, session.id),
    ).toEqual([]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(5);
  });

  it("rolls back pending snapshot-delete rows when hard-delete metadata deletion fails", async () => {
    const db = new DatabaseSync(":memory:");
    const fixture = createFixture({
      fileStorage: true,
      sessionStore: new SqliteSessionStore(db),
    });
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

    db.exec(`
      CREATE TRIGGER fail_session_delete
      BEFORE DELETE ON sessions
      BEGIN
        SELECT RAISE(ABORT, 'injected session delete failure');
      END;
    `);

    await expect(
      fixture.sessions.delete(DEFAULT_WORKSPACE_ID, session.id),
    ).rejects.toThrow("injected session delete failure");

    expect(fixture.sessionStore.retrieveAny(DEFAULT_WORKSPACE_ID, session.id)?.id)
      .toBe(session.id);
    expect(fixture.sessionStore.getFileMountSnapshots(DEFAULT_WORKSPACE_ID, session.id))
      .toHaveLength(1);
    expect(
      fixture.sessionStore.getPendingInternalSnapshotDeletes(DEFAULT_WORKSPACE_ID, session.id),
    ).toEqual([]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(10);
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

  it("clears create-rollback rows on successful commit and sweep is a no-op", async () => {
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
    const snapshot = fixture.sessionStore.getFileMountSnapshots(
      DEFAULT_WORKSPACE_ID,
      session.id,
    )[0]!;

    expect(
      fixture.sessionStore.getPendingInternalSnapshotCreateRollbacks(
        DEFAULT_WORKSPACE_ID,
        session.id,
      ),
    ).toEqual([]);

    await fixture.sessions.sweepPendingInternalSnapshotCreateRollbacks(
      DEFAULT_WORKSPACE_ID,
      session.id,
    );

    expect(
      fixture.fileStorage!.getInternalRecordForTest(snapshot.snapshot_file_id),
    ).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({ id: snapshot.snapshot_file_id }),
      }),
    );
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(10);
    expect(fixture.sessionStore.getFileMountSnapshots(DEFAULT_WORKSPACE_ID, session.id))
      .toEqual([snapshot]);
  });

  it("queues create-rollback cleanup when session persistence fails and storage delete fails", async () => {
    const fileStorage = new FaultyInternalSnapshotDeleteStorage();
    fileStorage.failAllDeletes = true;
    const fixture = createFixture({
      fileStorage,
      failSessionCreate: true,
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

    expect(fixture.sessionStore.list(DEFAULT_WORKSPACE_ID, { includeArchived: true }).data)
      .toEqual([]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(10);
    const pending = fixture.sessionStore.getPendingInternalSnapshotCreateRollbacks(
      DEFAULT_WORKSPACE_ID,
    );
    expect(pending).toEqual([
      expect.objectContaining({
        workspace_id: DEFAULT_WORKSPACE_ID,
        attempt_count: 1,
        last_attempt_at: expect.any(String),
        last_error: "injected snapshot delete failure",
      }),
    ]);
    expect(
      fixture.sessionStore.getFileMountSnapshots(
        DEFAULT_WORKSPACE_ID,
        pending[0]!.session_id,
      ),
    ).toEqual([]);
  });

  it("retries create-rollback cleanup during normal uptime", async () => {
    vi.useFakeTimers();
    const fileStorage = new FaultyInternalSnapshotDeleteStorage();
    fileStorage.failAllDeletes = true;
    const fixture = createFixture({
      fileStorage,
      failSessionCreate: true,
      pendingSnapshotCleanupRetryDelayMs: 25,
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
    expect(
      fixture.sessionStore.getPendingInternalSnapshotCreateRollbacks(
        DEFAULT_WORKSPACE_ID,
      ),
    ).toHaveLength(1);

    fileStorage.failAllDeletes = false;
    await vi.advanceTimersByTimeAsync(25);

    expect(
      fixture.sessionStore.getPendingInternalSnapshotCreateRollbacks(
        DEFAULT_WORKSPACE_ID,
      ),
    ).toEqual([]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(5);
  });

  it("stops automatic create-rollback cleanup retries at the cap", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fileStorage = new FaultyInternalSnapshotDeleteStorage();
    fileStorage.failAllDeletes = true;
    const fixture = createFixture({
      fileStorage,
      failSessionCreate: true,
      pendingSnapshotCleanupRetryDelayMs: 25,
      pendingSnapshotCleanupMaxAttempts: 1,
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

    const pending = fixture.sessionStore.getPendingInternalSnapshotCreateRollbacks(
      DEFAULT_WORKSPACE_ID,
    );
    expect(pending).toEqual([expect.objectContaining({ attempt_count: 1 })]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(10);
    expect(warn).toHaveBeenCalledWith(
      "Pending internal snapshot create rollback reached retry cap",
      expect.objectContaining({
        workspaceId: DEFAULT_WORKSPACE_ID,
        sessionId: pending[0]!.session_id,
        resourceId: pending[0]!.resource_id,
        snapshotFileId: pending[0]!.snapshot_file_id,
        attemptCount: 1,
        maxAttempts: 1,
        error: "injected snapshot delete failure",
      }),
    );

    fileStorage.failAllDeletes = false;
    await vi.advanceTimersByTimeAsync(25);

    expect(
      fixture.sessionStore.getPendingInternalSnapshotCreateRollbacks(
        DEFAULT_WORKSPACE_ID,
      ),
    ).toEqual([expect.objectContaining({ attempt_count: 1 })]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(10);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("skips capped create-rollback siblings during later sweeps", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fileStorage = new FaultyInternalSnapshotDeleteStorage();
    const fixture = createFixture({
      fileStorage,
      pendingSnapshotCleanupMaxAttempts: 2,
    });
    const firstSnapshot = await fixture.fileStorage!.createInternalSnapshot(
      DEFAULT_WORKSPACE_ID,
      {
        fileId: "file_failed_capped_create_rollback",
        filename: "first.txt",
        mimeType: "text/plain",
        scopeId: "sesrsc_failed_capped_create_rollback",
        body: bytes("first"),
      },
    );
    const secondSnapshot = await fixture.fileStorage!.createInternalSnapshot(
      DEFAULT_WORKSPACE_ID,
      {
        fileId: "file_retryable_create_rollback",
        filename: "second.txt",
        mimeType: "text/plain",
        scopeId: "sesrsc_retryable_create_rollback",
        body: bytes("second"),
      },
    );
    fixture.sessionStore.recordPendingInternalSnapshotCreateRollback(
      rollbackRow({
        resourceId: "sesrsc_failed_capped_create_rollback",
        snapshotFileId: firstSnapshot.metadata.id,
        sizeBytes: firstSnapshot.metadata.size_bytes,
      }),
      new Date().toISOString(),
    );
    fixture.sessionStore.recordPendingInternalSnapshotCreateRollback(
      rollbackRow({
        resourceId: "sesrsc_retryable_create_rollback",
        snapshotFileId: secondSnapshot.metadata.id,
        sizeBytes: secondSnapshot.metadata.size_bytes,
      }),
      new Date().toISOString(),
    );
    fixture.sessionStore.recordPendingInternalSnapshotCreateRollbackAttempt(
      DEFAULT_WORKSPACE_ID,
      "sesn_create_rollback",
      "sesrsc_failed_capped_create_rollback",
      new Date().toISOString(),
      "first failure",
    );
    fixture.sessionStore.recordPendingInternalSnapshotCreateRollbackAttempt(
      DEFAULT_WORKSPACE_ID,
      "sesn_create_rollback",
      "sesrsc_failed_capped_create_rollback",
      new Date().toISOString(),
      "manually capped for test",
    );
    fixture.sessionStore.recordPendingInternalSnapshotCreateRollbackAttempt(
      DEFAULT_WORKSPACE_ID,
      "sesn_create_rollback",
      "sesrsc_retryable_create_rollback",
      new Date().toISOString(),
      "first failure",
    );
    fileStorage.failDeletesFor.add(firstSnapshot.metadata.id);
    fileStorage.failDeletesFor.add(secondSnapshot.metadata.id);

    await fixture.sessions.sweepPendingInternalSnapshotCreateRollbacks(
      DEFAULT_WORKSPACE_ID,
      "sesn_create_rollback",
    );

    expect(
      fixture.sessionStore.getPendingInternalSnapshotCreateRollbacks(
        DEFAULT_WORKSPACE_ID,
        "sesn_create_rollback",
      ),
    ).toEqual([
      expect.objectContaining({
        resource_id: "sesrsc_failed_capped_create_rollback",
        attempt_count: 2,
      }),
      expect.objectContaining({
        resource_id: "sesrsc_retryable_create_rollback",
        attempt_count: 2,
      }),
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Pending internal snapshot create rollback reached retry cap",
      expect.objectContaining({
        resourceId: "sesrsc_retryable_create_rollback",
        snapshotFileId: secondSnapshot.metadata.id,
        attemptCount: 2,
      }),
    );
  });

  it("startup sweep recovers create-rollback rows after a crash window", async () => {
    const fixture = createFixture({ fileStorage: true });
    const snapshot = await fixture.fileStorage!.createInternalSnapshot(
      DEFAULT_WORKSPACE_ID,
      {
        fileId: "file_create_rollback_snapshot",
        filename: "probe.txt",
        mimeType: "text/plain",
        scopeId: "sesrsc_create_rollback",
        body: bytes("snap"),
      },
    );
    fixture.sessionStore.recordPendingInternalSnapshotCreateRollback(
      rollbackRow({
        snapshotFileId: snapshot.metadata.id,
        sizeBytes: snapshot.metadata.size_bytes,
      }),
      new Date(Date.now() - 1_000).toISOString(),
    );

    const restarted = new DefaultSessionService(
      fixture.sessionStore,
      fixture.agentStore,
      fixture.environmentStore,
      fixture.fileStorage,
    );
    await restarted.drainStartupSnapshotSweepsForTest();

    expect(
      fixture.sessionStore.getPendingInternalSnapshotCreateRollbacks(
        DEFAULT_WORKSPACE_ID,
      ),
    ).toEqual([]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(0);
  });

  it("clears create-rollback rows when snapshot bytes are already absent", async () => {
    const fixture = createFixture({ fileStorage: true });
    fixture.sessionStore.recordPendingInternalSnapshotCreateRollback(
      rollbackRow({ snapshotFileId: "file_already_absent" }),
      new Date().toISOString(),
    );

    await fixture.sessions.sweepPendingInternalSnapshotCreateRollbacks(
      DEFAULT_WORKSPACE_ID,
      "sesn_create_rollback",
    );

    expect(
      fixture.sessionStore.getPendingInternalSnapshotCreateRollbacks(
        DEFAULT_WORKSPACE_ID,
      ),
    ).toEqual([]);
  });

  it("clears successful create-rollback siblings while keeping failed rows queued", async () => {
    const fileStorage = new FaultyInternalSnapshotDeleteStorage();
    const fixture = createFixture({ fileStorage });
    const failedSnapshot = await fixture.fileStorage!.createInternalSnapshot(
      DEFAULT_WORKSPACE_ID,
      {
        fileId: "file_failed_create_rollback",
        filename: "failed.txt",
        mimeType: "text/plain",
        scopeId: "sesrsc_failed_create_rollback",
        body: bytes("first"),
      },
    );
    const successfulSnapshot = await fixture.fileStorage!.createInternalSnapshot(
      DEFAULT_WORKSPACE_ID,
      {
        fileId: "file_successful_create_rollback",
        filename: "successful.txt",
        mimeType: "text/plain",
        scopeId: "sesrsc_successful_create_rollback",
        body: bytes("second"),
      },
    );
    fixture.sessionStore.recordPendingInternalSnapshotCreateRollback(
      rollbackRow({
        resourceId: "sesrsc_failed_create_rollback",
        snapshotFileId: failedSnapshot.metadata.id,
        sizeBytes: failedSnapshot.metadata.size_bytes,
      }),
      new Date().toISOString(),
    );
    fixture.sessionStore.recordPendingInternalSnapshotCreateRollback(
      rollbackRow({
        resourceId: "sesrsc_successful_create_rollback",
        snapshotFileId: successfulSnapshot.metadata.id,
        sizeBytes: successfulSnapshot.metadata.size_bytes,
      }),
      new Date().toISOString(),
    );
    fileStorage.failDeletesFor.add(failedSnapshot.metadata.id);

    await fixture.sessions.sweepPendingInternalSnapshotCreateRollbacks(
      DEFAULT_WORKSPACE_ID,
      "sesn_create_rollback",
    );

    expect(
      fixture.sessionStore.getPendingInternalSnapshotCreateRollbacks(
        DEFAULT_WORKSPACE_ID,
        "sesn_create_rollback",
      ),
    ).toEqual([
      expect.objectContaining({
        resource_id: "sesrsc_failed_create_rollback",
        snapshot_file_id: failedSnapshot.metadata.id,
        attempt_count: 1,
      }),
    ]);
    expect(
      fixture.fileStorage!.getInternalRecordForTest(successfulSnapshot.metadata.id),
    ).toBeUndefined();
    expect(
      fixture.fileStorage!.getInternalRecordForTest(failedSnapshot.metadata.id),
    ).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({ id: failedSnapshot.metadata.id }),
      }),
    );
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(5);
  });

  it("does not sweep another workspace's create-rollback rows", async () => {
    const fixture = createFixture({ fileStorage: true });
    const snapshot = await fixture.fileStorage!.createInternalSnapshot(
      DEFAULT_WORKSPACE_ID,
      {
        fileId: "file_cross_workspace_create_rollback",
        filename: "probe.txt",
        mimeType: "text/plain",
        scopeId: "sesrsc_create_rollback",
        body: bytes("snap"),
      },
    );
    fixture.sessionStore.recordPendingInternalSnapshotCreateRollback(
      rollbackRow({
        snapshotFileId: snapshot.metadata.id,
        sizeBytes: snapshot.metadata.size_bytes,
      }),
      new Date().toISOString(),
    );

    await fixture.sessions.sweepPendingInternalSnapshotCreateRollbacks(
      OTHER_WORKSPACE_ID,
    );

    expect(
      fixture.sessionStore.getPendingInternalSnapshotCreateRollbacks(
        DEFAULT_WORKSPACE_ID,
      ),
    ).toHaveLength(1);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(4);

    await fixture.sessions.sweepPendingInternalSnapshotCreateRollbacks(
      DEFAULT_WORKSPACE_ID,
    );
    expect(
      fixture.sessionStore.getPendingInternalSnapshotCreateRollbacks(
        DEFAULT_WORKSPACE_ID,
      ),
    ).toEqual([]);
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(0);
  });

  it("rejects storage backends that do not honor requested internal snapshot ids", async () => {
    const fileStorage = new NonHonoringInternalSnapshotIdStorage();
    const fixture = createFixture({ fileStorage });
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
    ).rejects.toThrow("expected file_");

    expect(fixture.sessionStore.list(DEFAULT_WORKSPACE_ID, { includeArchived: true }).data)
      .toEqual([]);
    expect(
      fixture.sessionStore.getPendingInternalSnapshotCreateRollbacks(
        DEFAULT_WORKSPACE_ID,
      ),
    ).toEqual([]);
    expect(
      fixture.fileStorage!.getInternalRecordForTest("file_unexpected_snapshot"),
    ).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({ id: "file_unexpected_snapshot" }),
      }),
    );
    expect(fixture.fileStorage!.getWorkspaceBytesForTest(DEFAULT_WORKSPACE_ID)).toBe(10);
  });

  it("startup create-rollback sweep ignores rows newer than the startup fence", async () => {
    const fixture = createFixture({ fileStorage: true });
    const snapshot = await fixture.fileStorage!.createInternalSnapshot(
      DEFAULT_WORKSPACE_ID,
      {
        fileId: "file_fresh_create_rollback",
        filename: "probe.txt",
        mimeType: "text/plain",
        scopeId: "sesrsc_fresh_create_rollback",
        body: bytes("snap"),
      },
    );
    fixture.sessionStore.recordPendingInternalSnapshotCreateRollback(
      rollbackRow({
        resourceId: "sesrsc_fresh_create_rollback",
        snapshotFileId: snapshot.metadata.id,
        sizeBytes: snapshot.metadata.size_bytes,
      }),
      new Date(Date.now() + 1_000).toISOString(),
    );

    const restarted = new DefaultSessionService(
      fixture.sessionStore,
      fixture.agentStore,
      fixture.environmentStore,
      fixture.fileStorage,
    );
    await restarted.drainStartupSnapshotSweepsForTest();

    expect(
      fixture.sessionStore.getPendingInternalSnapshotCreateRollbacks(
        DEFAULT_WORKSPACE_ID,
      ),
    ).toHaveLength(1);
    expect(
      fixture.fileStorage!.getInternalRecordForTest(snapshot.metadata.id),
    ).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({ id: snapshot.metadata.id }),
      }),
    );
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
      agent: { id: agent.id, version: 1 },
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
    fileStorage?: boolean | InMemoryFileStorage;
    failSessionCreate?: boolean;
    maxFileResources?: number;
    maxMountedBytes?: number;
    runtime?: RuntimeEventRunner;
    sessionStore?: SqliteSessionStore;
    pendingSnapshotCleanupRetryDelayMs?: number;
    pendingSnapshotCleanupMaxAttempts?: number;
  } = {},
): {
  sessions: DefaultSessionService;
  sessionStore: SqliteSessionStore;
  agentStore: SqliteAgentStore;
  environmentStore: SqliteEnvironmentStore;
  fileStorage?: InMemoryFileStorage;
  createAgent(workspaceId: string, name: string): { id: string };
  createEnvironment(workspaceId: string, name: string): { id: string };
} {
  const agentStore = SqliteAgentStore.open(":memory:");
  const environmentStore = SqliteEnvironmentStore.open(":memory:");
  const sessionStore = opts.sessionStore ?? SqliteSessionStore.open(":memory:");
  const agents = new DefaultAgentService(agentStore);
  const environments = new DefaultEnvironmentService(environmentStore);
  const fileStorage =
    opts.fileStorage instanceof InMemoryFileStorage
      ? opts.fileStorage
      : opts.fileStorage
        ? new InMemoryFileStorage()
        : undefined;
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
      ...(opts.pendingSnapshotCleanupRetryDelayMs === undefined
        ? {}
        : {
            pendingSnapshotCleanupRetryDelayMs:
              opts.pendingSnapshotCleanupRetryDelayMs,
          }),
      ...(opts.pendingSnapshotCleanupMaxAttempts === undefined
        ? {}
        : {
            pendingSnapshotCleanupMaxAttempts:
              opts.pendingSnapshotCleanupMaxAttempts,
          }),
    },
  );

  return {
    sessions,
    sessionStore,
    agentStore,
    environmentStore,
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
    agent: RuntimeSessionPrepareOptions["agent"];
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
      agent: opts.agent,
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

class FaultyInternalSnapshotDeleteStorage extends InMemoryFileStorage {
  readonly failDeletesFor = new Set<string>();
  failAllDeletes = false;

  override async deleteInternalSnapshot(
    workspaceId: string,
    fileId: string,
  ): Promise<boolean> {
    if (this.failAllDeletes || this.failDeletesFor.has(fileId)) {
      throw new Error("injected snapshot delete failure");
    }
    return super.deleteInternalSnapshot(workspaceId, fileId);
  }
}

class NonHonoringInternalSnapshotIdStorage extends InMemoryFileStorage {
  override createInternalSnapshot(
    workspaceId: string,
    input: Parameters<InMemoryFileStorage["createInternalSnapshot"]>[1],
  ): ReturnType<InMemoryFileStorage["createInternalSnapshot"]> {
    const { fileId: _ignored, ...rest } = input;
    return super.createInternalSnapshot(workspaceId, {
      ...rest,
      fileId: "file_unexpected_snapshot",
    });
  }
}

function failCreateStore(delegate: SqliteSessionStore): SessionStore {
  return {
    create(): never {
      throw new Error("injected session create failure");
    },
    retrieve: delegate.retrieve.bind(delegate),
    retrieveAny: delegate.retrieveAny.bind(delegate),
    countActive: delegate.countActive.bind(delegate),
    archive: delegate.archive.bind(delegate),
    delete: delegate.delete.bind(delegate),
    getFileMountSnapshots: delegate.getFileMountSnapshots.bind(delegate),
    listPendingInternalSnapshotDeleteWorkspaces:
      delegate.listPendingInternalSnapshotDeleteWorkspaces.bind(delegate),
    getPendingInternalSnapshotDeletes:
      delegate.getPendingInternalSnapshotDeletes.bind(delegate),
    recordPendingInternalSnapshotDeleteAttempt:
      delegate.recordPendingInternalSnapshotDeleteAttempt.bind(delegate),
    clearPendingInternalSnapshotDelete:
      delegate.clearPendingInternalSnapshotDelete.bind(delegate),
    recordPendingInternalSnapshotCreateRollback:
      delegate.recordPendingInternalSnapshotCreateRollback.bind(delegate),
    listPendingInternalSnapshotCreateRollbackWorkspaces:
      delegate.listPendingInternalSnapshotCreateRollbackWorkspaces.bind(delegate),
    getPendingInternalSnapshotCreateRollbacks:
      delegate.getPendingInternalSnapshotCreateRollbacks.bind(delegate),
    recordPendingInternalSnapshotCreateRollbackAttempt:
      delegate.recordPendingInternalSnapshotCreateRollbackAttempt.bind(delegate),
    clearPendingInternalSnapshotCreateRollback:
      delegate.clearPendingInternalSnapshotCreateRollback.bind(delegate),
    list: delegate.list.bind(delegate),
    close: delegate.close.bind(delegate),
  };
}

function rollbackRow(
  opts: {
    resourceId?: string;
    snapshotFileId: string;
    sizeBytes?: number;
    sessionId?: string;
  },
): SessionFileMountSnapshotRow {
  return {
    workspace_id: DEFAULT_WORKSPACE_ID,
    session_id: opts.sessionId ?? "sesn_create_rollback",
    resource_id: opts.resourceId ?? "sesrsc_create_rollback",
    file_id: "file_source",
    mount_path: "probe.txt",
    snapshot_file_id: opts.snapshotFileId,
    sha256: "sha256",
    size_bytes: opts.sizeBytes ?? 4,
  };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
