import { chmodSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultAgentService } from "../agents/service.ts";
import { createBestEffortRuntimeEventCoordinator } from "../deployment-runtime-event-coordinator.ts";
import { createBestEffortSessionOutputCoordinator } from "../deployment-session-output-coordinator.ts";
import {
  createDeploymentStoresFromEnv,
} from "../deployment-storage.ts";
import { DefaultEnvironmentService } from "../environments/service.ts";
import { DefaultFileService } from "../files/service.ts";
import { LocalObjectFileStorage } from "../files/store.ts";
import { DefaultSessionService } from "../sessions/service.ts";
import type { SessionRow } from "../sessions/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, {
    recursive: true,
    force: true,
  })));
});

describe("deployment storage", () => {
  it("requires durable SQLite and object storage config together", () => {
    expect(() =>
      createDeploymentStoresFromEnv({ OMA_SQLITE_PATH: "/tmp/oma.sqlite" }),
    ).toThrow("OMA_SQLITE_PATH and OMA_FILE_STORAGE_ROOT must be set together");

    expect(() =>
      createDeploymentStoresFromEnv({ OMA_FILE_STORAGE_ROOT: "/tmp/oma-files" }),
    ).toThrow("OMA_SQLITE_PATH and OMA_FILE_STORAGE_ROOT must be set together");

    expect(() =>
      createDeploymentStoresFromEnv({
        OMA_SQLITE_PATH: ":memory:",
        OMA_FILE_STORAGE_ROOT: "/tmp/oma-files",
      }),
    ).toThrow("OMA_SQLITE_PATH must be a file path");

    expect(() =>
      createDeploymentStoresFromEnv({
        OMA_SQLITE_PATH: "   ",
        OMA_FILE_STORAGE_ROOT: "/tmp/oma-files",
      }),
    ).toThrow("Durable storage env vars must not be empty");
  });

  it("persists deployment control-plane metadata across app recreation", async () => {
    const paths = await durablePaths();
    const env = {
      OMA_SQLITE_PATH: paths.sqlitePath,
      OMA_FILE_STORAGE_ROOT: paths.objectRoot,
    };
    const stores = createDeploymentStoresFromEnv(env);
    const agents = new DefaultAgentService(stores.agents);
    const environments = new DefaultEnvironmentService(stores.environments);
    const files = new DefaultFileService(stores.files);
    const sessions = new DefaultSessionService(
      stores.sessions,
      stores.agents,
      stores.environments,
      stores.files,
      { deleteSessionRows: stores.sessionCoordinator.deleteSessionRows },
    );
    const agent = agents.create("wrk_default", {
      name: "Durable Agent",
      model: "claude-opus-4-7",
      tools: [{ type: "agent_toolset_20260401" }],
    });
    const environment = environments.create("wrk_default", {
      name: "Durable Environment",
      config: { type: "cloud", networking: { type: "unrestricted" } },
    });
    const session = await sessions.create("wrk_default", {
      agent: agent.id,
      environment_id: environment.id,
    });
    const uploaded = await files.upload("wrk_default", {
      filename: "input.txt",
      mimeType: "text/plain",
      body: new TextEncoder().encode("durable input"),
    });
    stores.events.append({
      id: "sevt_restart_probe",
      workspace_id: "wrk_default",
      session_id: session.id,
      type: "user.message",
      processed_at: new Date().toISOString(),
      payload: { content: [{ type: "text", text: "hello" }] },
      created_at: new Date().toISOString(),
    });
    stores.close();

    const restarted = createDeploymentStoresFromEnv(env);
    expect(new DefaultAgentService(restarted.agents).retrieve("wrk_default", agent.id))
      .toMatchObject({ id: agent.id, name: agent.name });
    expect(
      new DefaultEnvironmentService(restarted.environments).retrieve(
        "wrk_default",
        environment.id,
      ),
    ).toMatchObject({ id: environment.id, name: environment.name });
    expect(
      new DefaultSessionService(
        restarted.sessions,
        restarted.agents,
        restarted.environments,
        restarted.files,
      ).retrieve("wrk_default", session.id),
    ).toMatchObject({ id: session.id, agent: { id: agent.id } });
    await expect(
      new DefaultFileService(restarted.files).retrieveMetadata(
        "wrk_default",
        uploaded.id,
      ),
    ).resolves.toMatchObject({
      id: uploaded.id,
      filename: "input.txt",
      size_bytes: 13,
    });
    expect(restarted.events.list("wrk_default", session.id, { order: "asc" }))
      .toMatchObject([{ id: "sevt_restart_probe", type: "user.message" }]);
    restarted.close();
  });

  it("persists downloadable session output bytes across store recreation", async () => {
    const paths = await durablePaths();
    const env = {
      OMA_SQLITE_PATH: paths.sqlitePath,
      OMA_FILE_STORAGE_ROOT: paths.objectRoot,
    };
    const stores = createDeploymentStoresFromEnv(env);
    const [record] = await stores.files.replaceSessionOutputs(
      "workspace_default",
      "sesn_output",
      [
        {
          relativePath: "reports/output.txt",
          filename: "output.txt",
          mimeType: "text/plain",
          body: new TextEncoder().encode("durable output"),
          sizeBytes: 14,
        },
      ],
    );
    stores.close();

    const restarted = createDeploymentStoresFromEnv(env);
    const metadata = await restarted.files.retrieveMetadata(
      "workspace_default",
      record!.metadata.id,
    );
    const body = await restarted.files.openBytes(
      "workspace_default",
      record!.metadata.id,
    );

    expect(metadata?.metadata).toMatchObject({
      id: record!.metadata.id,
      filename: "output.txt",
      downloadable: true,
      scope: { type: "session", id: "sesn_output" },
    });
    await expect(textFrom(body)).resolves.toBe("durable output");
    restarted.close();
  });

  it("deletes session rows and pending runtime rows in one deployment operation", async () => {
    const paths = await durablePaths();
    const stores = createDeploymentStoresFromEnv({
      OMA_SQLITE_PATH: paths.sqlitePath,
      OMA_FILE_STORAGE_ROOT: paths.objectRoot,
    });
    const sessionId = "sesn_delete_probe";
    stores.sessions.create({ row: sessionRow(sessionId) });
    stores.events.appendBatchWithRuntimeChanges([], {
      acceptedTurns: [
        {
          workspaceId: "wrk_default",
          sessionId,
          turnId: "turn_delete_probe",
          ownerId: "wrk_default",
          ownerGeneration: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          triggerEventIds: [],
          now: new Date().toISOString(),
        },
      ],
    });
    const sessions = new DefaultSessionService(
      stores.sessions,
      stores.agents,
      stores.environments,
      stores.files,
      { deleteSessionRows: stores.sessionCoordinator.deleteSessionRows },
    );

    await expect(sessions.delete("wrk_default", sessionId)).resolves.toEqual({
      id: sessionId,
      type: "session_deleted",
    });
    expect(stores.events.listPendingRuntimeTurns("wrk_default")).toEqual([]);
    expect(stores.sessions.retrieveAny("wrk_default", sessionId)).toBeUndefined();
    stores.close();
  });

  it("cleans in-memory session events and runtime turns on session delete", () => {
    const stores = createDeploymentStoresFromEnv({});
    const sessionId = "sesn_memory_delete";
    stores.sessions.create({ row: sessionRow(sessionId) });
    stores.events.append({
      id: "sevt_memory_delete",
      workspace_id: "wrk_default",
      session_id: sessionId,
      type: "user.message",
      processed_at: new Date().toISOString(),
      payload: { content: [{ type: "text", text: "remove me" }] },
      created_at: new Date().toISOString(),
    });
    stores.events.appendBatchWithRuntimeChanges([], {
      acceptedTurns: [
        {
          workspaceId: "wrk_default",
          sessionId,
          turnId: "turn_memory_delete",
          ownerId: "wrk_default",
          ownerGeneration: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          triggerEventIds: [],
          now: new Date().toISOString(),
        },
      ],
    });

    const deleted = stores.sessionCoordinator.deleteSessionRows(
      "wrk_default",
      sessionId,
    );

    expect(deleted?.row.id).toBe(sessionId);
    expect(stores.sessions.retrieveAny("wrk_default", sessionId)).toBeUndefined();
    expect(stores.events.list("wrk_default", sessionId)).toEqual([]);
    expect(stores.events.listPendingRuntimeTurns("wrk_default")).toEqual([]);
    stores.close();
  });

  it("commits runtime events through the deployment runtime event coordinator", () => {
    const stores = createDeploymentStoresFromEnv({});
    const sessionId = "sesn_runtime_event_commit";
    const now = new Date().toISOString();
    stores.sessions.create({ row: sessionRow(sessionId) });
    stores.events.appendBatchWithRuntimeChanges([], {
      acceptedTurns: [
        {
          workspaceId: "wrk_default",
          sessionId,
          turnId: "turn_runtime_event_commit",
          ownerId: "owner_runtime",
          ownerGeneration: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          triggerEventIds: [],
          now,
        },
      ],
    });

    stores.runtimeEventCoordinator.commitRuntimeEventsForTurn({
      workspaceId: "wrk_default",
      sessionId,
      turnId: "turn_runtime_event_commit",
      ownerId: "owner_runtime",
      ownerGeneration: 1,
      events: [
        {
          id: "sevt_runtime_event_commit",
          workspace_id: "wrk_default",
          session_id: sessionId,
          type: "agent.message",
          processed_at: now,
          payload: { content: [{ type: "text", text: "committed" }] },
          created_at: now,
        },
      ],
      changes: {
        turnStates: [
          {
            workspaceId: "wrk_default",
            sessionId,
            turnId: "turn_runtime_event_commit",
            ownerId: "owner_runtime",
            ownerGeneration: 1,
            state: "running",
            now,
          },
        ],
      },
    });

    expect(stores.events.list("wrk_default", sessionId)).toMatchObject([
      { id: "sevt_runtime_event_commit", type: "agent.message" },
    ]);
    expect(stores.events.listPendingRuntimeTurns("wrk_default")).toMatchObject([
      { turn_id: "turn_runtime_event_commit", state: "running" },
    ]);
    stores.close();
  });

  it("rejects stale runtime event commits before appending transcript rows", async () => {
    const paths = await durablePaths();
    const stores = createDeploymentStoresFromEnv({
      OMA_SQLITE_PATH: paths.sqlitePath,
      OMA_FILE_STORAGE_ROOT: paths.objectRoot,
    });
    const sessionId = "sesn_runtime_event_stale_owner";
    const now = new Date().toISOString();
    stores.sessions.create({ row: sessionRow(sessionId) });
    stores.events.appendBatchWithRuntimeChanges([], {
      acceptedTurns: [
        {
          workspaceId: "wrk_default",
          sessionId,
          turnId: "turn_runtime_event_stale_owner",
          ownerId: "owner_runtime",
          ownerGeneration: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          triggerEventIds: [],
          now,
        },
      ],
    });

    expect(() =>
      stores.runtimeEventCoordinator.commitRuntimeEventsForTurn({
        workspaceId: "wrk_default",
        sessionId,
        turnId: "turn_runtime_event_stale_owner",
        ownerId: "owner_runtime",
        ownerGeneration: 2,
        events: [
          {
            id: "sevt_runtime_event_stale_owner",
            workspace_id: "wrk_default",
            session_id: sessionId,
            type: "agent.message",
            processed_at: now,
            payload: { content: [{ type: "text", text: "stale" }] },
            created_at: now,
          },
        ],
        changes: {
          turnStates: [
            {
              workspaceId: "wrk_default",
              sessionId,
              turnId: "turn_runtime_event_stale_owner",
              ownerId: "owner_runtime",
              ownerGeneration: 2,
              state: "running",
              now,
            },
          ],
        },
      }),
    ).toThrow("Runtime turn ownership lost: turn_runtime_event_stale_owner");
    expect(stores.events.list("wrk_default", sessionId)).toEqual([]);
    expect(stores.events.listPendingRuntimeTurns("wrk_default")).toMatchObject([
      {
        turn_id: "turn_runtime_event_stale_owner",
        owner_generation: 1,
        state: "accepted",
      },
    ]);
    stores.close();
  });

  it("rejects best-effort stale runtime event commits before appending transcript rows", () => {
    const stores = createDeploymentStoresFromEnv({});
    const coordinator = createBestEffortRuntimeEventCoordinator({
      sessions: stores.sessions,
      events: stores.events,
    });
    const sessionId = "sesn_runtime_event_best_effort_stale";
    const now = new Date().toISOString();
    stores.sessions.create({ row: sessionRow(sessionId) });
    stores.events.appendBatchWithRuntimeChanges([], {
      acceptedTurns: [
        {
          workspaceId: "wrk_default",
          sessionId,
          turnId: "turn_runtime_event_best_effort_stale",
          ownerId: "owner_runtime",
          ownerGeneration: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          triggerEventIds: [],
          now,
        },
      ],
    });

    expect(() =>
      coordinator.commitRuntimeEventsForTurn({
        workspaceId: "wrk_default",
        sessionId,
        turnId: "turn_runtime_event_best_effort_stale",
        ownerId: "owner_runtime",
        ownerGeneration: 2,
        events: [
          {
            id: "sevt_runtime_event_best_effort_stale",
            workspace_id: "wrk_default",
            session_id: sessionId,
            type: "agent.message",
            processed_at: now,
            payload: { content: [{ type: "text", text: "stale" }] },
            created_at: now,
          },
        ],
        changes: {
          turnStates: [
            {
              workspaceId: "wrk_default",
              sessionId,
              turnId: "turn_runtime_event_best_effort_stale",
              ownerId: "owner_runtime",
              ownerGeneration: 2,
              state: "running",
              now,
            },
          ],
        },
      }),
    ).toThrow("Runtime turn ownership lost: turn_runtime_event_best_effort_stale");
    expect(stores.events.list("wrk_default", sessionId)).toEqual([]);
    expect(stores.events.listPendingRuntimeTurns("wrk_default")).toMatchObject([
      {
        turn_id: "turn_runtime_event_best_effort_stale",
        owner_generation: 1,
        state: "accepted",
      },
    ]);
    stores.close();
  });

  it("deletes session-output metadata in the same deployment delete transaction", async () => {
    const paths = await durablePaths();
    const stores = createDeploymentStoresFromEnv({
      OMA_SQLITE_PATH: paths.sqlitePath,
      OMA_FILE_STORAGE_ROOT: paths.objectRoot,
    });
    stores.sessions.create({ row: sessionRow("sesn_delete_outputs") });
    const [output] = await stores.files.replaceSessionOutputs(
      "wrk_default",
      "sesn_delete_outputs",
      [
        {
          relativePath: "output.txt",
          filename: "output.txt",
          mimeType: "text/plain",
          body: new TextEncoder().encode("deleted output"),
          sizeBytes: 14,
        },
      ],
    );

    const deleted = stores.sessionCoordinator.deleteSessionRows(
      "wrk_default",
      "sesn_delete_outputs",
    );

    expect(deleted?.row.id).toBe("sesn_delete_outputs");
    expect(deleted?.deletedSessionOutputFiles?.map((file) => file.metadata.id))
      .toEqual([output!.metadata.id]);
    await expect(
      stores.files.retrieveMetadata("wrk_default", output!.metadata.id),
    ).resolves.toBeUndefined();
    stores.close();
  });

  it("rolls back durable deployment delete when session-output metadata deletion fails", async () => {
    const paths = await durablePaths();
    const schemaDb = new DatabaseSync(paths.sqlitePath);
    new LocalObjectFileStorage(schemaDb, paths.objectRoot);
    schemaDb.exec(`
      CREATE TRIGGER fail_session_output_delete
      BEFORE DELETE ON files
      WHEN OLD.kind = 'session_output' AND OLD.scope_id = 'sesn_delete_rollback'
      BEGIN
        SELECT RAISE(ABORT, 'injected session output delete failure');
      END;
    `);
    schemaDb.close();

    const stores = createDeploymentStoresFromEnv({
      OMA_SQLITE_PATH: paths.sqlitePath,
      OMA_FILE_STORAGE_ROOT: paths.objectRoot,
    });
    const sessionId = "sesn_delete_rollback";
    stores.sessions.create({ row: sessionRow(sessionId) });
    stores.events.append({
      id: "sevt_delete_rollback",
      workspace_id: "wrk_default",
      session_id: sessionId,
      type: "user.message",
      processed_at: new Date().toISOString(),
      payload: { content: [{ type: "text", text: "keep me" }] },
      created_at: new Date().toISOString(),
    });
    stores.events.appendBatchWithRuntimeChanges([], {
      acceptedTurns: [
        {
          workspaceId: "wrk_default",
          sessionId,
          turnId: "turn_delete_rollback",
          ownerId: "wrk_default",
          ownerGeneration: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          triggerEventIds: [],
          now: new Date().toISOString(),
        },
      ],
    });
    const [output] = await stores.files.replaceSessionOutputs(
      "wrk_default",
      sessionId,
      [
        {
          relativePath: "output.txt",
          filename: "output.txt",
          mimeType: "text/plain",
          body: new TextEncoder().encode("still visible"),
          sizeBytes: 13,
        },
      ],
    );

    expect(() =>
      stores.sessionCoordinator.deleteSessionRows("wrk_default", sessionId),
    ).toThrow("injected session output delete failure");

    expect(stores.sessions.retrieveAny("wrk_default", sessionId)?.id).toBe(
      sessionId,
    );
    expect(stores.events.list("wrk_default", sessionId, { order: "asc" }))
      .toMatchObject([{ id: "sevt_delete_rollback" }]);
    expect(stores.events.listPendingRuntimeTurns("wrk_default"))
      .toMatchObject([
        { session_id: sessionId, turn_id: "turn_delete_rollback" },
      ]);
    await expect(
      stores.files.retrieveMetadata("wrk_default", output!.metadata.id),
    ).resolves.toMatchObject({ metadata: { id: output!.metadata.id } });
    stores.close();
  });

  it("deletes public file metadata before best-effort object cleanup", async () => {
    const paths = await durablePaths();
    const db = new DatabaseSync(paths.sqlitePath);
    const storage = new LocalObjectFileStorage(db, paths.objectRoot);
    const record = await storage.create("wrk_default", {
      filename: "delete-me.txt",
      mimeType: "text/plain",
      body: new TextEncoder().encode("delete me"),
    });
    const objectPath = join(paths.objectRoot, "objects", record.storage_key);
    await rm(objectPath, { force: true });
    await mkdir(objectPath);

    await expect(
      storage.delete("wrk_default", record.metadata.id),
    ).rejects.toThrow();
    await expect(
      storage.retrieveMetadata("wrk_default", record.metadata.id),
    ).resolves.toBeUndefined();

    db.close();
  });

  it("rejects stale session-output commits inside the durable file transaction", async () => {
    const paths = await durablePaths();
    const db = new DatabaseSync(paths.sqlitePath);
    const storage = new LocalObjectFileStorage(db, paths.objectRoot);

    await expect(
      storage.replaceSessionOutputsIfLive(
        "wrk_default",
        "sesn_stale",
        [
          {
            relativePath: "late.txt",
            filename: "late.txt",
            mimeType: "text/plain",
            body: new TextEncoder().encode("late"),
            sizeBytes: 4,
          },
        ],
        () => false,
      ),
    ).rejects.toThrow("cannot be committed for inactive session");
    const page = await storage.list("wrk_default", { scopeId: "sesn_stale" });
    expect(page.data).toEqual([]);
    db.close();
  });

  it("commits session outputs through the deployment output coordinator", async () => {
    const paths = await durablePaths();
    const stores = createDeploymentStoresFromEnv({
      OMA_SQLITE_PATH: paths.sqlitePath,
      OMA_FILE_STORAGE_ROOT: paths.objectRoot,
    });
    const sessionId = "sesn_output_commit";
    stores.sessions.create({ row: sessionRow(sessionId) });
    stores.events.appendBatchWithRuntimeChanges([], {
      acceptedTurns: [
        {
          workspaceId: "wrk_default",
          sessionId,
          turnId: "turn_output_commit",
          ownerId: "owner_output",
          ownerGeneration: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          triggerEventIds: [],
          now: new Date().toISOString(),
        },
      ],
    });

    const [output] =
      await stores.sessionOutputCoordinator.replaceSessionOutputsForRuntimeTurn({
        workspaceId: "wrk_default",
        sessionId,
        turnId: "turn_output_commit",
        ownerId: "owner_output",
        ownerGeneration: 1,
        files: [
          {
            relativePath: "output.txt",
            filename: "output.txt",
            mimeType: "text/plain",
            body: new TextEncoder().encode("coordinated"),
            sizeBytes: 11,
          },
        ],
      });

    await expect(
      stores.files.retrieveMetadata("wrk_default", output!.metadata.id),
    ).resolves.toMatchObject({
      metadata: {
        id: output!.metadata.id,
        scope: { type: "session", id: sessionId },
      },
    });
    stores.close();
  });

  it("rejects session output commits for stale runtime owners", async () => {
    const paths = await durablePaths();
    const stores = createDeploymentStoresFromEnv({
      OMA_SQLITE_PATH: paths.sqlitePath,
      OMA_FILE_STORAGE_ROOT: paths.objectRoot,
    });
    const sessionId = "sesn_output_stale_owner";
    stores.sessions.create({ row: sessionRow(sessionId) });
    stores.events.appendBatchWithRuntimeChanges([], {
      acceptedTurns: [
        {
          workspaceId: "wrk_default",
          sessionId,
          turnId: "turn_output_stale_owner",
          ownerId: "owner_output",
          ownerGeneration: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          triggerEventIds: [],
          now: new Date().toISOString(),
        },
      ],
    });

    await expect(
      stores.sessionOutputCoordinator.replaceSessionOutputsForRuntimeTurn({
        workspaceId: "wrk_default",
        sessionId,
        turnId: "turn_output_stale_owner",
        ownerId: "owner_output",
        ownerGeneration: 2,
        files: [
          {
            relativePath: "late.txt",
            filename: "late.txt",
            mimeType: "text/plain",
            body: new TextEncoder().encode("late"),
            sizeBytes: 4,
          },
        ],
      }),
    ).rejects.toThrow("cannot be committed for inactive session");
    await expect(
      stores.files.list("wrk_default", { scopeId: sessionId }),
    ).resolves.toMatchObject({ data: [] });
    stores.close();
  });

  it("rejects session output commits for archived sessions", async () => {
    const paths = await durablePaths();
    const stores = createDeploymentStoresFromEnv({
      OMA_SQLITE_PATH: paths.sqlitePath,
      OMA_FILE_STORAGE_ROOT: paths.objectRoot,
    });
    const sessionId = "sesn_output_archived";
    stores.sessions.create({ row: sessionRow(sessionId) });
    stores.events.appendBatchWithRuntimeChanges([], {
      acceptedTurns: [
        {
          workspaceId: "wrk_default",
          sessionId,
          turnId: "turn_output_archived",
          ownerId: "owner_output",
          ownerGeneration: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          triggerEventIds: [],
          now: new Date().toISOString(),
        },
      ],
    });
    stores.sessions.archive("wrk_default", sessionId, new Date().toISOString());

    await expect(
      stores.sessionOutputCoordinator.replaceSessionOutputsForRuntimeTurn({
        workspaceId: "wrk_default",
        sessionId,
        turnId: "turn_output_archived",
        ownerId: "owner_output",
        ownerGeneration: 1,
        files: [
          {
            relativePath: "archived.txt",
            filename: "archived.txt",
            mimeType: "text/plain",
            body: new TextEncoder().encode("archived"),
            sizeBytes: 8,
          },
        ],
      }),
    ).rejects.toThrow("cannot be committed for inactive session");
    await expect(
      stores.files.list("wrk_default", { scopeId: sessionId }),
    ).resolves.toMatchObject({ data: [] });
    stores.close();
  });

  it("rejects best-effort session output commits before writing stale outputs", async () => {
    const stores = createDeploymentStoresFromEnv({});
    const coordinator = createBestEffortSessionOutputCoordinator({
      sessions: stores.sessions,
      events: stores.events,
      files: stores.files,
    });
    const sessionId = "sesn_output_best_effort_stale";
    stores.sessions.create({ row: sessionRow(sessionId) });
    stores.events.appendBatchWithRuntimeChanges([], {
      acceptedTurns: [
        {
          workspaceId: "wrk_default",
          sessionId,
          turnId: "turn_output_best_effort_stale",
          ownerId: "owner_output",
          ownerGeneration: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          triggerEventIds: [],
          now: new Date().toISOString(),
        },
      ],
    });

    await expect(
      coordinator.replaceSessionOutputsForRuntimeTurn({
        workspaceId: "wrk_default",
        sessionId,
        turnId: "turn_output_best_effort_stale",
        ownerId: "owner_output",
        ownerGeneration: 2,
        files: [
          {
            relativePath: "late.txt",
            filename: "late.txt",
            mimeType: "text/plain",
            body: new TextEncoder().encode("late"),
            sizeBytes: 4,
          },
        ],
      }),
    ).rejects.toThrow("cannot be committed for inactive session");
    await expect(
      stores.files.list("wrk_default", { scopeId: sessionId }),
    ).resolves.toMatchObject({ data: [] });
    stores.close();
  });

  it("serializes durable workspace quota accounting across concurrent uploads", async () => {
    const paths = await durablePaths();
    const db = new DatabaseSync(paths.sqlitePath);
    const storage = new LocalObjectFileStorage(db, paths.objectRoot, {
      maxWorkspaceFileBytes: 10,
      maxUploadedFileBytes: 10,
    });

    const results = await Promise.allSettled([
      storage.create("wrk_default", {
        filename: "a.txt",
        mimeType: "text/plain",
        body: delayedBytes("123456"),
      }),
      storage.create("wrk_default", {
        filename: "b.txt",
        mimeType: "text/plain",
        body: delayedBytes("abcdef"),
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const page = await storage.list("wrk_default");
    expect(page.data).toHaveLength(1);
    expect(page.data[0]!.metadata.size_bytes).toBe(6);
    db.close();
  });

  it("sweeps temporary and orphaned object bytes on startup", async () => {
    const paths = await durablePaths();
    await mkdir(join(paths.objectRoot, "objects"), { recursive: true });
    await mkdir(join(paths.objectRoot, "tmp"), { recursive: true });
    const orphanPath = join(paths.objectRoot, "objects", "orphan.bin");
    const tmpPath = join(paths.objectRoot, "tmp", "partial.tmp");
    await writeFile(orphanPath, "orphan");
    await writeFile(tmpPath, "partial");

    const stores = createDeploymentStoresFromEnv({
      OMA_SQLITE_PATH: paths.sqlitePath,
      OMA_FILE_STORAGE_ROOT: paths.objectRoot,
    });
    stores.close();

    expect(existsSync(orphanPath)).toBe(false);
    expect(existsSync(tmpPath)).toBe(false);
  });

  it("creates durable metadata and object roots with restrictive host modes", async () => {
    const paths = await durablePaths();
    await mkdir(join(paths.objectRoot, "objects"), { recursive: true, mode: 0o777 });
    await mkdir(join(paths.objectRoot, "tmp"), { recursive: true, mode: 0o777 });
    chmodSync(paths.objectRoot, 0o777);
    chmodSync(join(paths.objectRoot, "objects"), 0o777);
    chmodSync(join(paths.objectRoot, "tmp"), 0o777);
    const stores = createDeploymentStoresFromEnv({
      OMA_SQLITE_PATH: paths.sqlitePath,
      OMA_FILE_STORAGE_ROOT: paths.objectRoot,
    });
    const [record] = await stores.files.replaceSessionOutputs(
      "wrk_default",
      "sesn_modes",
      [
        {
          relativePath: "output.txt",
          filename: "output.txt",
          mimeType: "text/plain",
          body: new TextEncoder().encode("modes"),
          sizeBytes: 5,
        },
      ],
    );
    stores.close();

    const sqliteMode = (await stat(paths.sqlitePath)).mode & 0o777;
    const rootMode = (await stat(paths.objectRoot)).mode & 0o777;
    const objectMode = (await stat(join(paths.objectRoot, "objects"))).mode & 0o777;
    const objectPath = join(paths.objectRoot, "objects", record!.storage_key);
    const byteMode = (await stat(objectPath)).mode & 0o777;

    expect(sqliteMode).toBe(0o600);
    expect(rootMode).toBe(0o700);
    expect(objectMode).toBe(0o700);
    expect(byteMode).toBe(0o600);
  });

  it("applies file-backed SQLite pragmas in durable mode", async () => {
    const paths = await durablePaths();
    const stores = createDeploymentStoresFromEnv({
      OMA_SQLITE_PATH: paths.sqlitePath,
      OMA_FILE_STORAGE_ROOT: paths.objectRoot,
    });
    expect(stores.sqlitePragmas?.()).toEqual({
      journalMode: "wal",
      busyTimeout: 5000,
      foreignKeys: 1,
      synchronous: 1,
    });
    stores.close();
  });

  it("locks durable SQLite database against overlapping deployment processes", async () => {
    const paths = await durablePaths();
    const env = {
      OMA_SQLITE_PATH: paths.sqlitePath,
      OMA_FILE_STORAGE_ROOT: paths.objectRoot,
    };
    const stores = createDeploymentStoresFromEnv(env);

    expect(() => createDeploymentStoresFromEnv(env)).toThrow(
      "Durable storage database is already locked",
    );

    stores.close();
    const restarted = createDeploymentStoresFromEnv(env);
    restarted.close();
  });

  it("recovers stale durable SQLite lock files on restart", async () => {
    const paths = await durablePaths();
    await writeFile(
      `${paths.sqlitePath}.oma.lock`,
      JSON.stringify({
        pid: 99_999_999,
        objectRoot: paths.objectRoot,
        createdAt: new Date().toISOString(),
      }),
    );

    const stores = createDeploymentStoresFromEnv({
      OMA_SQLITE_PATH: paths.sqlitePath,
      OMA_FILE_STORAGE_ROOT: paths.objectRoot,
    });
    expect(stores.mode).toBe("durable");
    stores.close();
  });

  it("rejects reusing a durable SQLite database with a different object root", async () => {
    const paths = await durablePaths();
    const env = {
      OMA_SQLITE_PATH: paths.sqlitePath,
      OMA_FILE_STORAGE_ROOT: paths.objectRoot,
    };
    const stores = createDeploymentStoresFromEnv(env);
    stores.close();

    expect(() =>
      createDeploymentStoresFromEnv({
        OMA_SQLITE_PATH: paths.sqlitePath,
        OMA_FILE_STORAGE_ROOT: join(paths.root, "other-objects"),
      }),
    ).toThrow("already bound to object storage root");
  });
});

async function durablePaths(): Promise<{
  root: string;
  sqlitePath: string;
  objectRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "oma-durable-storage-"));
  tempDirs.push(root);
  return {
    root,
    sqlitePath: join(root, "oma.sqlite"),
    objectRoot: join(root, "objects"),
  };
}

function sessionRow(id: string): SessionRow {
  const now = new Date().toISOString();
  return {
    id,
    workspace_id: "wrk_default",
    type: "session",
    agent: { type: "agent", id: "agent_seed", version: 1 },
    environment_id: "env_seed",
    status: "idle",
    title: null,
    metadata: {},
    created_at: now,
    updated_at: now,
    archived_at: null,
    usage: null,
    resources: [],
  };
}

async function textFrom(
  body: AsyncIterable<Uint8Array> | undefined,
): Promise<string> {
  expect(body).toBeDefined();
  const chunks: Uint8Array[] = [];
  for await (const chunk of body!) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function* delayedBytes(text: string): AsyncIterable<Uint8Array> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  yield new TextEncoder().encode(text);
}
