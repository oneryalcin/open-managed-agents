import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SqliteAgentStore } from "../store.ts";
import { DefaultAgentService } from "../service.ts";

const REQUEST = {
  name: "Scoped Agent",
  model: "claude-opus-4-7",
  tools: [{ type: "agent_toolset_20260401" }],
};

describe("AgentService + AgentStore", () => {
  it("backfills legacy agent heads as immutable version one", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE agents (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, type TEXT NOT NULL,
      name TEXT NOT NULL, model TEXT NOT NULL, system TEXT, description TEXT,
      tools TEXT NOT NULL, skills TEXT NOT NULL, mcp_servers TEXT NOT NULL,
      metadata TEXT NOT NULL, multiagent TEXT, version INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
    )`);
    db.prepare(`INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "agent_legacy", "wrk_default", "agent", "Legacy",
        JSON.stringify({ id: "claude-opus-4-7", speed: "standard" }),
        null, null, "[]", "[]", "[]", "{}", null, 1,
        "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", null,
      );

    const store = new SqliteAgentStore(db);
    expect(store.retrieveAny("wrk_default", "agent_legacy")?.model).toEqual({
      provider: "anthropic",
      id: "claude-opus-4-7",
      speed: "standard",
    });
    expect(store.retrieveVersion("wrk_default", "agent_legacy", 1)).toMatchObject({
      id: "agent_legacy",
      version: 1,
      name: "Legacy",
      model: {
        provider: "anthropic",
        id: "claude-opus-4-7",
        speed: "standard",
      },
    });
  });

  it("migrates legacy heads and existing immutable revisions before backfill", () => {
    const db = new DatabaseSync(":memory:");
    new SqliteAgentStore(db);
    insertRawAgent(db, {
      id: "agent_legacy_versions",
      version: 2,
      model: { id: "claude-opus-4-7", speed: "fast" },
    });
    insertRawAgentVersion(db, {
      id: "agent_legacy_versions",
      version: 1,
      model: { id: "claude-opus-4-6", speed: "standard" },
    });

    const store = new SqliteAgentStore(db);
    expect(store.retrieveVersion("wrk_default", "agent_legacy_versions", 1)?.model)
      .toEqual({
        provider: "anthropic",
        id: "claude-opus-4-6",
        speed: "standard",
      });
    expect(store.retrieveVersion("wrk_default", "agent_legacy_versions", 2)?.model)
      .toEqual({
        provider: "anthropic",
        id: "claude-opus-4-7",
        speed: "fast",
      });
    expect(new SqliteAgentStore(db).retrieveAny(
      "wrk_default",
      "agent_legacy_versions",
    )?.model.provider).toBe("anthropic");
  });

  it("rolls back the entire startup migration when any model row is malformed", () => {
    const db = new DatabaseSync(":memory:");
    new SqliteAgentStore(db);
    insertRawAgent(db, {
      id: "agent_migration_rollback",
      version: 2,
      model: { id: "claude-opus-4-7", speed: "standard" },
    });
    insertRawAgentVersion(db, {
      id: "agent_migration_rollback",
      version: 1,
      model: { id: 42, speed: "standard" },
    });

    expect(() => new SqliteAgentStore(db)).toThrow(
      "Invalid persisted model id for agent version agent_migration_rollback@1",
    );
    const head = db.prepare("SELECT model FROM agents WHERE id = ?")
      .get("agent_migration_rollback") as { model: string };
    expect(JSON.parse(head.model)).toEqual({
      id: "claude-opus-4-7",
      speed: "standard",
    });
    expect(db.prepare(
      "SELECT count(*) AS count FROM agent_versions WHERE agent_id = ?",
    ).get("agent_migration_rollback")).toEqual({ count: 1 });
  });

  it("rolls back create when revision one insertion fails", () => {
    const db = new DatabaseSync(":memory:");
    const store = new SqliteAgentStore(db);
    const service = new DefaultAgentService(store, undefined);
    db.exec(`CREATE TRIGGER fail_agent_v1 BEFORE INSERT ON agent_versions
      WHEN NEW.version = 1 BEGIN SELECT RAISE(ABORT, 'injected create failure'); END`);

    expect(() => service.create("wrk_default", REQUEST))
      .toThrow("injected create failure");
    expect(service.list("wrk_default").data).toEqual([]);
  });

  it("rolls back the head when immutable revision insertion fails", () => {
    const db = new DatabaseSync(":memory:");
    const store = new SqliteAgentStore(db);
    const service = new DefaultAgentService(store, undefined);
    const created = service.create("wrk_default", REQUEST);
    db.exec(`CREATE TRIGGER fail_agent_v2 BEFORE INSERT ON agent_versions
      WHEN NEW.version = 2 BEGIN SELECT RAISE(ABORT, 'injected version failure'); END`);

    expect(() => service.update("wrk_default", created.id, {
      version: 1,
      description: "must roll back",
    })).toThrow("injected version failure");
    expect(service.retrieve("wrk_default", created.id)).toEqual(created);
    expect(store.retrieveVersion("wrk_default", created.id, 2)).toBeUndefined();
  });

  it("scopes agents by workspace internally", () => {
    const store = SqliteAgentStore.open(":memory:");
    const service = new DefaultAgentService(store, undefined);

    const agent = service.create("wrk_a", REQUEST);

    expect(service.retrieve("wrk_a", agent.id).id).toBe(agent.id);
    expect(store.retrieveAny("wrk_a", agent.id)?.id).toBe(agent.id);
    expect(() => service.retrieve("wrk_b", agent.id)).toThrow(
      `Agent ${agent.id} not found`,
    );
  });

  it("keeps immutable revisions and authenticates newest-first history cursors", () => {
    const store = SqliteAgentStore.open(":memory:");
    const service = new DefaultAgentService(store, undefined);
    const v1 = service.create("wrk_default", {
      ...REQUEST,
      system: "v1",
      metadata: { keep: "one", remove: "yes" },
    });
    const v2 = service.update("wrk_default", v1.id, {
      version: 1,
      system: "v2",
      metadata: { keep: "two", remove: null },
    });
    const v3 = service.update("wrk_default", v1.id, {
      version: 2,
      description: "v3",
    });

    expect(service.retrieve("wrk_default", v1.id, 1)).toEqual(v1);
    expect(service.retrieve("wrk_default", v1.id, 2)).toEqual(v2);
    expect(service.retrieve("wrk_default", v1.id)).toEqual(v3);
    const first = service.listVersions("wrk_default", v1.id, { limit: 2 });
    expect(first.data.map((agent) => agent.version)).toEqual([3, 2]);
    expect(first.next_page).toEqual(expect.any(String));
    const second = service.listVersions("wrk_default", v1.id, {
      limit: 2,
      page: first.next_page!,
    });
    expect(second.data.map((agent) => agent.version)).toEqual([1]);
    expect(second.next_page).toBe(null);
    expect(() => service.listVersions("wrk_default", v1.id, {
      page: `${first.next_page}!`,
    })).toThrow("invalid page cursor");
    const other = service.create("wrk_default", { ...REQUEST, name: "Other" });
    expect(() => service.listVersions("wrk_default", other.id, {
      page: first.next_page!,
    })).toThrow("invalid page cursor");
    expect(() => service.listVersions("wrk_other", v1.id, {
      page: first.next_page!,
    })).toThrow(`Agent ${v1.id} not found`);
  });

  it("archives agents idempotently while preserving direct lookup", () => {
    const store = SqliteAgentStore.open(":memory:");
    const service = new DefaultAgentService(store, undefined);
    const agent = service.create("wrk_default", REQUEST);

    const archived = service.archive("wrk_default", agent.id);

    expect(archived.id).toBe(agent.id);
    expect(archived.archived_at).toEqual(expect.any(String));
    expect(store.retrieve("wrk_default", agent.id)).toBeUndefined();
    expect(service.retrieve("wrk_default", agent.id)).toEqual(archived);
    expect(service.retrieve("wrk_default", agent.id, 1)).toMatchObject({
      ...agent,
      archived_at: archived.archived_at,
    });
    expect(() => service.update("wrk_default", agent.id, {
      version: 1,
      description: "after archive",
    })).toThrow("Cannot modify archived agent");
    expect(service.list("wrk_default")).toEqual({
      data: [],
      has_more: false,
      next_page: null,
    });
    expect(service.list("wrk_default", { includeArchived: true })).toEqual({
      data: [archived],
      has_more: false,
      next_page: null,
    });

    const archivedAgain = service.archive("wrk_default", agent.id);
    expect(archivedAgain.archived_at).toBe(archived.archived_at);
    expect(archivedAgain.updated_at).toBe(archived.updated_at);
  });

  it("does not leak archived agents across workspaces", () => {
    const store = SqliteAgentStore.open(":memory:");
    const service = new DefaultAgentService(store, undefined);
    const agent = service.create("wrk_a", REQUEST);

    expect(() => service.archive("wrk_b", agent.id)).toThrow(
      `Agent ${agent.id} not found`,
    );
    expect(service.retrieve("wrk_a", agent.id).archived_at).toBe(null);
    expect(store.retrieveAny("wrk_b", agent.id)).toBeUndefined();
  });

  it("paginates list results by opaque next_page cursor", () => {
    const store = SqliteAgentStore.open(":memory:");
    const service = new DefaultAgentService(store, undefined);
    const first = service.create("wrk_default", {
      ...REQUEST,
      name: "First",
    });
    const second = service.create("wrk_default", {
      ...REQUEST,
      name: "Second",
    });

    const page1 = service.list("wrk_default", { limit: 1 });
    expect(page1).toEqual({
      data: [first],
      has_more: true,
      next_page: first.id,
    });

    const page2 = service.list("wrk_default", {
      limit: 1,
      page: page1.next_page ?? undefined,
    });
    expect(page2).toEqual({
      data: [second],
      has_more: false,
      next_page: null,
    });
  });

  it("does not treat an empty cursor as a valid store page", () => {
    const store = SqliteAgentStore.open(":memory:");
    const service = new DefaultAgentService(store, undefined);
    service.create("wrk_default", REQUEST);

    expect(store.list("wrk_default", { page: "" })).toEqual({
      data: [],
      has_more: false,
      next_page: null,
    });
  });

  it("scopes list results by workspace internally", () => {
    const store = SqliteAgentStore.open(":memory:");
    const service = new DefaultAgentService(store, undefined);
    const agentA = service.create("wrk_a", REQUEST);
    service.create("wrk_b", { ...REQUEST, name: "Other Workspace" });

    expect(service.list("wrk_a")).toEqual({
      data: [agentA],
      has_more: false,
      next_page: null,
    });
  });

  it("rejects unavailable models before create or update persistence", () => {
    const store = SqliteAgentStore.open(":memory:");
    const service = new DefaultAgentService(store, undefined, {
      assertAvailable: (model) => {
        if (model.id !== "allowed") throw new Error(`unavailable:${model.id}`);
      },
    });
    expect(() => service.create("wrk_default", { ...REQUEST, model: "blocked" }))
      .toThrow("unavailable:blocked");
    expect(service.list("wrk_default").data).toEqual([]);
    const created = service.create("wrk_default", { ...REQUEST, model: "allowed" });
    expect(() => service.update("wrk_default", created.id, {
      version: 1,
      model: "blocked",
    })).toThrow("unavailable:blocked");
    expect(service.retrieve("wrk_default", created.id).version).toBe(1);
  });

  it("normalizes CMA model inputs without using deployment defaults", () => {
    const store = SqliteAgentStore.open(":memory:");
    const seen: Array<{ provider: string; id: string }> = [];
    const service = new DefaultAgentService(store, undefined, {
      assertAvailable: (model) => seen.push(model),
    });

    const stringModel = service.create("wrk_default", REQUEST);
    const providerless = service.create("wrk_default", {
      ...REQUEST,
      name: "Providerless",
      model: { id: "claude-sonnet-5", speed: "fast" },
    });
    const explicit = service.create("wrk_default", {
      ...REQUEST,
      name: "Explicit",
      model: { provider: "openai", id: "gpt-5.4" },
    });

    expect(stringModel.model).toEqual({
      provider: "anthropic",
      id: "claude-opus-4-7",
      speed: "standard",
    });
    expect(providerless.model).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-5",
      speed: "fast",
    });
    expect(explicit.model).toEqual({
      provider: "openai",
      id: "gpt-5.4",
      speed: "standard",
    });
    expect(seen).toEqual([
      stringModel.model,
      providerless.model,
      explicit.model,
    ]);
  });

  it("rejects malformed provider extensions and unknown model fields", () => {
    const service = new DefaultAgentService(
      SqliteAgentStore.open(":memory:"),
      undefined,
    );
    expect(() => service.create("wrk_default", {
      ...REQUEST,
      model: { provider: "", id: "gpt-5.4" },
    })).toThrow("`model.provider` must be a non-empty string");
    expect(() => service.create("wrk_default", {
      ...REQUEST,
      model: { provider: "openai", id: "gpt-5.4", fallback: true },
    })).toThrow("Unknown field `model.fallback`");
    expect(service.list("wrk_default").data).toEqual([]);
  });

  it("includes provider identity in no-op and immutable-version comparison", () => {
    const service = new DefaultAgentService(
      SqliteAgentStore.open(":memory:"),
      undefined,
    );
    const v1 = service.create("wrk_default", {
      ...REQUEST,
      model: { provider: "openai", id: "shared-id" },
    });
    const noOp = service.update("wrk_default", v1.id, {
      version: 1,
      model: { provider: "openai", id: "shared-id" },
    });
    const v2 = service.update("wrk_default", v1.id, {
      version: 1,
      model: { provider: "anthropic", id: "shared-id" },
    });

    expect(noOp.version).toBe(1);
    expect(v2).toMatchObject({
      version: 2,
      model: { provider: "anthropic", id: "shared-id", speed: "standard" },
    });
    expect(service.retrieve("wrk_default", v1.id, 1).model.provider).toBe("openai");
  });

  it("accepts exactly twenty distinct skill attachments", () => {
    const store = SqliteAgentStore.open(":memory:");
    const service = new DefaultAgentService(store, {
      getSkill: (_workspaceId, skillId) => ({
        id: skillId,
        display_title: skillId,
        latest_version: "1",
        source: "custom",
        type: "skill",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
      getVersion: (_workspaceId, skillId, version) => ({
        id: `skill_version_${skillId}`,
        skill_id: skillId,
        version,
        name: skillId,
        description: "test",
        directory: skillId,
        type: "skill_version",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    });
    const skills = Array.from({ length: 20 }, (_, index) => ({
      type: "custom" as const,
      skill_id: `skill_${index}`,
    }));
    expect(service.create("wrk_default", { ...REQUEST, skills }).skills).toEqual(skills);
  });
});

function insertRawAgent(
  db: DatabaseSync,
  input: { id: string; version: number; model: unknown },
): void {
  db.prepare(`INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      input.id,
      "wrk_default",
      "agent",
      "Legacy",
      JSON.stringify(input.model),
      null,
      null,
      "[]",
      "[]",
      "[]",
      "{}",
      null,
      input.version,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      null,
    );
}

function insertRawAgentVersion(
  db: DatabaseSync,
  input: { id: string; version: number; model: unknown },
): void {
  db.prepare(`INSERT INTO agent_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      "wrk_default",
      input.id,
      input.version,
      "Legacy",
      JSON.stringify(input.model),
      null,
      null,
      "[]",
      "[]",
      "[]",
      "{}",
      null,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
}
