import { chmodSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultAgentService } from "../agents/service.ts";
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
      { deleteSessionRows: stores.deleteSessionRows },
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
      { deleteSessionRows: stores.deleteSessionRows },
    );

    await expect(sessions.delete("wrk_default", sessionId)).resolves.toEqual({
      id: sessionId,
      type: "session_deleted",
    });
    expect(stores.events.listPendingRuntimeTurns("wrk_default")).toEqual([]);
    expect(stores.sessions.retrieveAny("wrk_default", sessionId)).toBeUndefined();
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

    const deleted = stores.deleteSessionRows(
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
