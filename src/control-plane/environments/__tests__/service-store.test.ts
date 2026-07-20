import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE_ID } from "../../workspace.ts";
import { DefaultEnvironmentService } from "../service.ts";
import { SqliteEnvironmentStore } from "../store.ts";
import { SqliteSessionStore } from "../../sessions/store.ts";

const OTHER_WORKSPACE_ID = "wrk_other";

describe("environment service/store", () => {
  it("keeps workspace rows isolated and does not leak workspace_id to wire responses", () => {
    const store = SqliteEnvironmentStore.open(":memory:");
    const service = new DefaultEnvironmentService(store);

    const first = service.create(DEFAULT_WORKSPACE_ID, {
      name: "Default",
      config: { type: "cloud" },
    });
    const second = service.create(OTHER_WORKSPACE_ID, {
      name: "Other",
      config: { type: "cloud" },
    });

    expect(first).not.toHaveProperty("workspace_id");
    expect(second).not.toHaveProperty("workspace_id");
    expect(service.list(DEFAULT_WORKSPACE_ID).data.map((e) => e.id)).toEqual([
      first.id,
    ]);
    expect(service.list(OTHER_WORKSPACE_ID).data.map((e) => e.id)).toEqual([
      second.id,
    ]);
  });

  it("treats an empty page cursor as an invalid direct store cursor", () => {
    const store = SqliteEnvironmentStore.open(":memory:");
    const service = new DefaultEnvironmentService(store);

    service.create(DEFAULT_WORKSPACE_ID, {
      name: "Default",
      config: { type: "cloud" },
    });

    expect(store.list(DEFAULT_WORKSPACE_ID, { page: "" })).toEqual({
      data: [],
      has_more: false,
      next_page: null,
    });
  });

  it("keeps archive and physical deletion workspace scoped", () => {
    const store = SqliteEnvironmentStore.open(":memory:");
    const sessions = SqliteSessionStore.open(":memory:");
    const service = new DefaultEnvironmentService(store, sessions);
    const environment = service.create(DEFAULT_WORKSPACE_ID, {
      name: "Default",
      config: { type: "cloud" },
    });

    expect(() => service.archive(OTHER_WORKSPACE_ID, environment.id)).toThrow(
      `Environment ${environment.id} not found`,
    );
    expect(() => service.delete(OTHER_WORKSPACE_ID, environment.id)).toThrow(
      `Environment ${environment.id} not found`,
    );
    expect(service.retrieve(DEFAULT_WORKSPACE_ID, environment.id).archived_at).toBeNull();
  });
});
