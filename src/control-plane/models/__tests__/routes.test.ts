import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDeploymentControlPlane,
  MANAGED_AGENTS_BETA,
  routeClassForPath,
  type DeploymentControlPlane,
} from "../../app.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("model catalog API", () => {
  it("is workspace-authenticated, beta-gated, route-classified, and secret-free", async () => {
    const fixture = makeFixture();
    try {
      expect(routeClassForPath("/v1/model-catalog")).toBe("v1");
      expect((await fixture.plane.app.request("/v1/model-catalog", {
        headers: betaHeaders(),
      })).status).toBe(401);
      expect((await fixture.plane.app.request("/v1/model-catalog", {
        headers: { "x-api-key": fixture.key },
      })).status).toBe(404);

      const response = await fixture.plane.app.request(
        "/v1/model-catalog?provider=anthropic&available=true&limit=100",
        { headers: requestHeaders(fixture.key) },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const body = await response.json() as ModelCatalogPage;
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data.filter((model) => model.default)).toHaveLength(1);
      expect(Object.keys(body.data[0]!).sort()).toEqual([
        "context_window",
        "credentials_configured",
        "default",
        "id",
        "input",
        "max_output_tokens",
        "name",
        "provider",
        "provider_name",
        "reasoning",
        "type",
      ]);
      expect(body.data.every((model) => model.provider === "anthropic")).toBe(true);
      expect(body.data.every((model) => model.credentials_configured)).toBe(true);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("test-model-secret");
      for (const forbidden of ["baseUrl", "headers", "auth.json", "models.json", "source", "label", "cost"]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      await fixture.plane.close();
    }
  });

  it("paginates in stable provider/id order and authenticates cursor context", async () => {
    const fixture = makeFixture();
    try {
      const first = await getPage(fixture.plane, fixture.key, "?limit=1");
      expect(first.data).toHaveLength(1);
      expect(first.next_page).toEqual(expect.any(String));

      const second = await getPage(
        fixture.plane,
        fixture.key,
        `?limit=1&page=${encodeURIComponent(first.next_page!)}`,
      );
      expect(second.data).toHaveLength(1);
      expect(compareRefs(first.data[0]!, second.data[0]!)).toBeLessThan(0);

      const changedFilter = await fixture.plane.app.request(
        `/v1/model-catalog?provider=anthropic&limit=1&page=${encodeURIComponent(first.next_page!)}`,
        { headers: requestHeaders(fixture.key) },
      );
      expect(changedFilter.status).toBe(400);
      expect(await errorMessage(changedFilter)).toBe("page token filters do not match request");

      const tampered = `${first.next_page!.slice(0, -1)}${first.next_page!.endsWith("A") ? "B" : "A"}`;
      const tamperedResponse = await fixture.plane.app.request(
        `/v1/model-catalog?limit=1&page=${encodeURIComponent(tampered)}`,
        { headers: requestHeaders(fixture.key) },
      );
      expect(tamperedResponse.status).toBe(400);
      expect(await errorMessage(tamperedResponse)).toBe("invalid page cursor");

      const otherWorkspace = fixture.plane.stores.workspaces.createWorkspace("other");
      const otherKey = fixture.plane.stores.workspaces.mintKey(otherWorkspace.workspace_id, "other").plaintextKey;
      const replay = await fixture.plane.app.request(
        `/v1/model-catalog?limit=1&page=${encodeURIComponent(first.next_page!)}`,
        { headers: requestHeaders(otherKey) },
      );
      expect(replay.status).toBe(400);
      expect(await errorMessage(replay)).toBe("invalid page cursor");
    } finally {
      await fixture.plane.close();
    }
  });

  it("rejects malformed query values before catalog access", async () => {
    const fixture = makeFixture();
    try {
      for (const query of ["?available=yes", "?limit=0", "?limit=101", "?provider=", "?page="]) {
        const response = await fixture.plane.app.request(`/v1/model-catalog${query}`, {
          headers: requestHeaders(fixture.key),
        });
        expect(response.status, query).toBe(400);
      }
    } finally {
      await fixture.plane.close();
    }
  });
});

function makeFixture(): { plane: DeploymentControlPlane; key: string } {
  const root = mkdtempSync(join(tmpdir(), "oma-model-routes-"));
  roots.push(root);
  const piRoot = join(root, "pi");
  mkdirSync(piRoot, { mode: 0o700 });
  writeFileSync(
    join(piRoot, "auth.json"),
    JSON.stringify({ anthropic: { type: "api_key", key: "test-model-secret" } }),
    { mode: 0o600 },
  );
  const plane = createDeploymentControlPlane({
    OMA_HOME: root,
    OMA_SQLITE_PATH: join(root, "oma.sqlite"),
    OMA_FILE_STORAGE_ROOT: join(root, "objects"),
    OMA_AUTH_MODE: "api-key",
  });
  const key = plane.stores.workspaces.mintKey("wrk_default", "model-test").plaintextKey;
  return { plane, key };
}

async function getPage(
  plane: DeploymentControlPlane,
  key: string,
  query: string,
): Promise<ModelCatalogPage> {
  const response = await plane.app.request(`/v1/model-catalog${query}`, {
    headers: requestHeaders(key),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<ModelCatalogPage>;
}

function requestHeaders(key: string): Record<string, string> {
  return { ...betaHeaders(), "x-api-key": key };
}

function betaHeaders(): Record<string, string> {
  return { "anthropic-beta": MANAGED_AGENTS_BETA };
}

async function errorMessage(response: Response): Promise<string> {
  return ((await response.json()) as { error: { message: string } }).error.message;
}

function compareRefs(left: ModelEntry, right: ModelEntry): number {
  if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

interface ModelCatalogPage {
  data: ModelEntry[];
  next_page: string | null;
}

interface ModelEntry {
  provider: string;
  id: string;
  credentials_configured: boolean;
  default: boolean;
  [key: string]: unknown;
}
