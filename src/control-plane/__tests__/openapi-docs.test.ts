import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDeploymentControlPlane,
  createInMemoryControlPlaneApp,
  type DeploymentControlPlane,
} from "../app.ts";
import { generateAdminKey } from "../admin/auth.ts";
import {
  MANAGED_AGENTS_BETA_HEADERS,
} from "./helpers.ts";
import {
  OPENAPI_ROUTE_CONTRACTS,
  openApiContractRouteKeys,
} from "../openapi/document.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OpenAPI and interactive documentation", () => {
  it("serves a deterministic public OpenAPI 3.1 document", async () => {
    const app = createInMemoryControlPlaneApp();
    const first = await app.request("/openapi.json");
    const second = await app.request("/openapi.json");

    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.text()).toBe(await second.text());

    const document = await (await app.request("/openapi.json")).json() as OpenApiDocument;
    expect(document.openapi).toBe("3.1.0");
    expect(document.info.title).toBe("Open Managed Agents API");
    expect(document.components.securitySchemes).toMatchObject({
      WorkspaceApiKey: { type: "apiKey", in: "header", name: "x-api-key" },
      AdminApiKey: { type: "apiKey", in: "header", name: "x-admin-key" },
    });
    expect(document.paths["/v1/sessions/{sessionId}/events/stream"].get.responses["200"])
      .toBeDefined();
    expect(document.paths["/v1/sessions"].get.responses["200"]).toBeDefined();
    expect(document.paths).not.toHaveProperty("/v1/deployments");
    expect(document.paths).not.toHaveProperty("/v1/memory");

    assertDocumentInternallyValid(document);
  });

  it("documents every shipped /v1 and /admin route exactly once", () => {
    const plane = makeDeploymentPlane();
    try {
      const runtimeKeys = plane.app.routes
        .filter((entry) => entry.method !== "ALL")
        .filter((entry) =>
          entry.path.startsWith("/v1/") ||
          entry.path.startsWith("/admin/") ||
          entry.path === "/health" ||
          entry.path === "/metrics"
        )
        .map((entry) => `${entry.method} ${toOpenApiPath(entry.path)}`)
        .sort();
      expect(runtimeKeys).toEqual(openApiContractRouteKeys());
      expect(new Set(openApiContractRouteKeys()).size).toBe(OPENAPI_ROUTE_CONTRACTS.length);
    } finally {
      plane.close();
    }
  });

  it("serves vendored docs assets with no-store containment and an air-gap CSP", async () => {
    const app = createInMemoryControlPlaneApp();
    const redirect = await app.request("/docs", { redirect: "manual" });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("/docs/");

    const index = await app.request("/docs/");
    expect(index.status).toBe(200);
    expect(index.headers.get("cache-control")).toBe("no-store");
    expect(index.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(index.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await index.text();
    expect(html).toContain("vendor/swagger-ui-bundle.js");
    expect(html).not.toMatch(/https?:\/\//);

    const initializer = await (await app.request("/docs/swagger-initializer.js")).text();
    expect(initializer).toContain("validatorUrl: null");
    expect(initializer).toContain("persistAuthorization: false");
    expect(initializer).not.toMatch(/localStorage|sessionStorage|document\.cookie/);

    const bundle = await app.request("/docs/vendor/swagger-ui-bundle.js");
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toBe("text/javascript; charset=utf-8");

    for (const path of [
      "/docs/nope.js",
      "/docs/..%2fpackage.json",
      "/docs/%252e%252e%252fpackage.json",
      "/docs/vendor/LICENSE",
    ]) {
      expect((await app.request(path)).status, path).toBe(404);
    }
  });

  it("keeps documentation public even when workspace authentication is enabled", async () => {
    const plane = makeDeploymentPlane();
    try {
      expect((await plane.app.request("/openapi.json")).status).toBe(200);
      expect((await plane.app.request("/docs/")).status).toBe(200);
      expect((await plane.app.request("/v1/agents", { headers: MANAGED_AGENTS_BETA_HEADERS })).status)
        .toBe(401);
      expect((await plane.app.request("/admin/workspaces")).status).toBe(401);
    } finally {
      plane.close();
    }
  });

  it("pins an executable alpha-path example to the documented request shapes", async () => {
    const app = createInMemoryControlPlaneApp();
    const agent = await postJson(app, "/v1/agents", {
      name: "Docs example agent",
      model: "claude-sonnet-5",
    });
    const environment = await postJson(app, "/v1/environments", {
      name: "Docs example environment",
      config: { type: "cloud" },
    });
    const session = await postJson(app, "/v1/sessions", {
      agent: agent.id,
      environment_id: environment.id,
    });
    expect(session).toMatchObject({
      type: "session",
      agent: { id: agent.id, version: 1 },
      environment_id: environment.id,
    });
  });
});

interface OpenApiDocument {
  openapi: string;
  info: { title: string };
  paths: Record<string, Record<string, {
    operationId: string;
    parameters?: Array<Record<string, unknown>>;
    security: Array<Record<string, unknown>>;
    responses: Record<string, unknown>;
  }>>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
}

function assertDocumentInternallyValid(document: OpenApiDocument): void {
  const operationIds = new Set<string>();
  const refs: string[] = [];
  walk(document, (key, value) => {
    if (key === "$ref" && typeof value === "string") refs.push(value);
  });
  for (const reference of refs) {
    expect(reference).toMatch(/^#\/components\/schemas\/[A-Za-z0-9]+$/);
    const name = reference.slice("#/components/schemas/".length);
    expect(document.components.schemas, reference).toHaveProperty(name);
  }

  for (const [path, methods] of Object.entries(document.paths)) {
    expect(path).toMatch(/^(?:\/(?:v1|admin)\/|\/(?:health|metrics)$)/);
    const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
    for (const operation of Object.values(methods)) {
      expect(operationIds.has(operation.operationId), operation.operationId).toBe(false);
      operationIds.add(operation.operationId);
      expect(Array.isArray(operation.security)).toBe(true);
      expect(Object.keys(operation.responses).some((status) => status.startsWith("2"))).toBe(true);
      const documented = (operation.parameters ?? [])
        .filter((parameter) => parameter.in === "path")
        .map((parameter) => parameter.name)
        .sort();
      expect(documented, path).toEqual(placeholders);
    }
  }
}

function walk(value: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    visit(key, item);
    walk(item, visit);
  }
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}");
}

function makeDeploymentPlane(): DeploymentControlPlane {
  const root = mkdtempSync(join(tmpdir(), "oma-openapi-"));
  roots.push(root);
  return createDeploymentControlPlane({
    OMA_SQLITE_PATH: join(root, "oma.sqlite"),
    OMA_FILE_STORAGE_ROOT: join(root, "objects"),
    OMA_AUTH_MODE: "api-key",
    OMA_ADMIN_KEY: generateAdminKey(),
  });
}

async function postJson(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
  path: string,
  body: unknown,
): Promise<Record<string, any>> {
  const response = await app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...MANAGED_AGENTS_BETA_HEADERS,
    },
    body: JSON.stringify(body),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<Record<string, any>>;
}
