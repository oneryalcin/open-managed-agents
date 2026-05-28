import { File } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createInMemoryControlPlaneApp } from "../app.ts";
import type { ApiErrorBody } from "../errors.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import type {
  ManagedAgentsSession,
  ManagedAgentsSessionFileResource,
} from "../../types/sessions.ts";
import type { ManagedAgentsFileMetadata } from "../../types/files.ts";

const VALID_AGENT = {
  name: "Resource Agent",
  model: "claude-opus-4-7",
  tools: [{ type: "agent_toolset_20260401" }],
};

const VALID_ENVIRONMENT = {
  name: "Resource Environment",
  config: { type: "cloud" },
};

describe("session file resources API", () => {
  it("echoes canonical file resources on create, retrieve, list, and archive", async () => {
    const app = createInMemoryControlPlaneApp();
    const agent = await createAgent(app);
    const environment = await createEnvironment(app);
    const input = await uploadFile(app, "probe.txt", "OMA_RESOURCE=ok\n");

    const created = await createSession(app, {
      agent: agent.id,
      environment_id: environment.id,
      resources: [
        { type: "file", file_id: input.id, mount_path: "probe.txt" },
        { type: "file", file_id: input.id, mount_path: "/tmp/probe.txt" },
      ],
    });

    expect(created.resources).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^sesrsc_/),
        type: "file",
        file_id: input.id,
        mount_path: "/mnt/session/uploads/probe.txt",
        created_at: expect.any(String),
        updated_at: expect.any(String),
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^sesrsc_/),
        type: "file",
        file_id: input.id,
        mount_path: "/mnt/session/uploads/tmp/probe.txt",
        created_at: expect.any(String),
        updated_at: expect.any(String),
      }),
    ]);
    for (const resource of created.resources) {
      expect(resource.created_at).toBe(resource.updated_at);
    }

    await expect(jsonFrom(app.request(`/v1/sessions/${created.id}`))).resolves.toMatchObject({
      resources: created.resources,
    });
    await expect(jsonFrom(app.request("/v1/sessions?limit=10"))).resolves.toMatchObject({
      data: [expect.objectContaining({ id: created.id, resources: created.resources })],
    });
    await expect(
      jsonFrom(
        app.request(`/v1/sessions/${created.id}/archive`, {
          method: "POST",
        }),
      ),
    ).resolves.toMatchObject({
      id: created.id,
      status: "terminated",
      resources: created.resources,
    });

    await deleteFile(app, input.id);
    await expect(jsonFrom(app.request(`/v1/sessions/${created.id}`))).resolves.toMatchObject({
      resources: created.resources,
    });
    await expect(jsonFrom(app.request(`/v1/files?scope_id=${created.id}`))).resolves.toEqual({
      data: [],
      has_more: false,
      first_id: null,
      last_id: null,
    });
    const publicFiles = JSON.stringify(await jsonFrom(app.request("/v1/files?limit=10")));
    expect(publicFiles).not.toContain("snapshot_file_id");
    expect(publicFiles).not.toContain("internal");
  });

  it("returns resources: [] on resource-free sessions", async () => {
    const app = createInMemoryControlPlaneApp();
    const agent = await createAgent(app);
    const environment = await createEnvironment(app);

    const created = await createSession(app, {
      agent: agent.id,
      environment_id: environment.id,
    });

    expect(created.resources).toEqual([]);
    await expect(jsonFrom(app.request(`/v1/sessions/${created.id}`))).resolves.toMatchObject({
      resources: [],
    });
  });

  it("canonicalizes omitted and nested mount paths", async () => {
    const app = createInMemoryControlPlaneApp();
    const agent = await createAgent(app);
    const environment = await createEnvironment(app);
    const file = await uploadFile(app, "probe.txt", "contents");
    const nullDefaultFile = await uploadFile(app, "null-default.txt", "contents");

    const created = await createSession(app, {
      agent: agent.id,
      environment_id: environment.id,
      resources: [
        { type: "file", file_id: file.id },
        { type: "file", file_id: nullDefaultFile.id, mount_path: null },
        { type: "file", file_id: file.id, mount_path: "data/probe.txt" },
      ],
    });

    expect(resourcePaths(created.resources)).toEqual([
      `/mnt/session/uploads/${file.id}`,
      `/mnt/session/uploads/${nullDefaultFile.id}`,
      "/mnt/session/uploads/data/probe.txt",
    ]);
  });

  it.each([
    [{ resources: null }, "`resources` must be an array"],
    [{ resources: "file_abc" }, "`resources` must be an array"],
    [{ resources: [null] }, "`resources[0]` must be an object"],
    [
      { resources: [{ type: "memory_store", memory_store_id: "mem_1" }] },
      "Unsupported session resource type: memory_store.",
    ],
    [
      { resources: [{ type: "github_repository", url: "https://github.com/a/b" }] },
      "Unsupported session resource type: github_repository.",
    ],
    [
      { resources: [{ type: "vault", vault_id: "vlt_1" }] },
      "Unsupported session resource type: vault.",
    ],
    [
      {
        resources: [
          { type: "file", file_id: "file_missing", mount_path: "x", extra: true },
        ],
      },
      "Unsupported session create field: `extra`.",
    ],
    [
      { resources: [{ type: "file", file_id: "file_missing", mount_path: "x" }] },
      "File file_missing not found",
    ],
    [
      { resources: [{ type: "file", file_id: "", mount_path: "x" }] },
      "`resources[0].file_id` must be a non-empty string",
    ],
    [
      {
        resources: [
          { type: "file", file_id: "file_missing", mount_path: "../probe.txt" },
        ],
      },
      "Invalid file resource: mount_path must not contain . or .. segments",
    ],
    [
      {
        resources: [
          { type: "file", file_id: "file_missing", mount_path: "data" },
          { type: "file", file_id: "file_missing", mount_path: "data/probe.txt" },
        ],
      },
      "Overlapping file resource mount_path",
    ],
    [
      {
        resources: [
          { type: "file", file_id: "file_missing", mount_path: "data/probe.txt" },
          { type: "file", file_id: "file_missing", mount_path: "/data/probe.txt" },
        ],
      },
      "Duplicate file resource mount_path",
    ],
  ])("rejects invalid resources: %j", async (override, message) => {
    const app = createInMemoryControlPlaneApp();
    const agent = await createAgent(app);
    const environment = await createEnvironment(app);

    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: agent.id,
        environment_id: environment.id,
        ...override,
      }),
    });

    await expectError(res, 400, "invalid_request_error", message);
  });

  it("rejects cross-workspace file mounts", async () => {
    const app = createInMemoryControlPlaneApp();
    const agent = await createAgent(app);
    const environment = await createEnvironment(app);

    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: agent.id,
        environment_id: environment.id,
        resources: [
          { type: "file", file_id: "file_looks_real_but_other_workspace" },
        ],
      }),
    });

    await expectError(
      res,
      400,
      "invalid_request_error",
      "File file_looks_real_but_other_workspace not found",
    );
  });
});

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

async function uploadFile(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
  filename: string,
  content: string,
): Promise<ManagedAgentsFileMetadata> {
  const form = new FormData();
  form.set("file", new File([content], filename, { type: "text/plain" }));
  const res = await app.request("/v1/files", {
    method: "POST",
    body: form,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsFileMetadata;
}

async function deleteFile(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
  fileId: string,
): Promise<void> {
  const res = await app.request(`/v1/files/${fileId}`, { method: "DELETE" });
  expect(res.status).toBe(200);
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

function resourcePaths(resources: ManagedAgentsSessionFileResource[]): string[] {
  return resources.map((resource) => resource.mount_path);
}

async function jsonFrom(response: Response | Promise<Response>): Promise<unknown> {
  const res = await response;
  expect(res.status).toBe(200);
  return res.json();
}

async function expectError(
  res: Response,
  status: number,
  type: ApiErrorBody["error"]["type"],
  message: string,
): Promise<void> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as ApiErrorBody;
  expect(body.error).toEqual({ type, message });
}
