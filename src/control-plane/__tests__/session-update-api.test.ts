import { describe, expect, it } from "vitest";
import { createInMemoryControlPlaneApp } from "./helpers.ts";
import { setupSession } from "./api-helpers.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";

// M2 session surface (decided 2026-10-10): POST /v1/sessions/{id} updates the
// title and metadata, as hosted (metadata is a patch: a string upserts, null
// deletes). Agent, budget and vault changes are refused honestly for now.

async function update(app: ReturnType<typeof createInMemoryControlPlaneApp>, id: string, body: unknown) {
  const res = await app.request(`/v1/sessions/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, session: (await res.json()) as ManagedAgentsSession };
}

async function sessionWith(metadata: Record<string, string>) {
  const app = createInMemoryControlPlaneApp();
  const session = await setupSession(app);
  await update(app, session.id, { metadata });
  return { app, session };
}

describe("session update", () => {
  it("sets the title", async () => {
    const app = createInMemoryControlPlaneApp();
    const session = await setupSession(app);

    expect((await update(app, session.id, { title: "Renamed" })).session.title).toBe("Renamed");
  });

  it("patches metadata: a string upserts a key and null deletes one", async () => {
    const { app, session } = await sessionWith({ keep: "1", drop: "2" });

    const { session: updated } = await update(app, session.id, { metadata: { drop: null, added: "3" } });

    expect(updated.metadata).toEqual({ keep: "1", added: "3" });
  });

  it("clears all metadata with null", async () => {
    const { app, session } = await sessionWith({ a: "1" });

    expect((await update(app, session.id, { metadata: null })).session.metadata).toEqual({});
  });

  it("keeps what the request leaves out", async () => {
    const { app, session } = await sessionWith({ a: "1" });

    expect((await update(app, session.id, { title: "T" })).session.metadata).toEqual({ a: "1" });
  });

  it("refuses an agent change it cannot apply yet", async () => {
    const app = createInMemoryControlPlaneApp();
    const session = await setupSession(app);

    expect((await update(app, session.id, { agent: { tools: [] } })).status).toBe(400);
  });

  it("refuses a title longer than 500 characters", async () => {
    const app = createInMemoryControlPlaneApp();
    const session = await setupSession(app);

    expect((await update(app, session.id, { title: "x".repeat(501) })).status).toBe(400);
  });

  it("refuses to update an archived session", async () => {
    const app = createInMemoryControlPlaneApp();
    const session = await setupSession(app);
    await app.request(`/v1/sessions/${session.id}/archive`, { method: "POST" });

    expect((await update(app, session.id, { title: "late" })).status).toBe(400);
  });
});
