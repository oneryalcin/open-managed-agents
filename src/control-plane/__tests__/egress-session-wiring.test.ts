// Plan 0117e-3: the session-path egress wiring. Two properties under test:
// (1) the per-session bundle resolver maps environment networking config into
// a sidecar bundle (or undefined — default deny), and (2) the fail-closed
// session-create gate rejects egress-granting environments the deployment
// cannot honor, while hosted-shape networking keeps today's behavior. The
// resolver also supports create-time sandbox preparation before the session
// row is committed by accepting an environmentId hint.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createDeploymentControlPlane as createRawDeploymentControlPlane,
  type DeploymentControlPlane,
  type DeploymentControlPlaneEnv,
} from "../app.ts";
import { createSessionEgressBundleResolver } from "../wiring.ts";
import { buildHooksFromBundle } from "../egress/policy.ts";
import {
  createEgressProxy,
  createMitmCA,
  disposeMitmCA,
} from "../egress/proxy.ts";
import { tunnelRequest } from "../egress/__tests__/tunnel-helpers.ts";
import { generateMasterKey, parseMasterKey } from "../secrets/master-key.ts";
import { SqliteSecretsStore } from "../secrets/store.ts";
import { SqliteEnvironmentStore } from "../environments/store.ts";
import { SqliteSessionStore } from "../sessions/store.ts";
import type { SessionRow } from "../sessions/types.ts";
import type { JsonObject } from "../../types/json.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import type { ApiErrorBody } from "../errors.ts";
import { MANAGED_AGENTS_BETA } from "./helpers.ts";

const GRANTING_NETWORKING = {
  allow: [{ host: "api.github.com", port: 443 }],
  credentials: [
    {
      host: "api.github.com",
      port: 443,
      env: "GITHUB_TOKEN",
      secret: "github",
      pathPrefix: "/",
      header: "authorization",
    },
  ],
};

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createDeploymentControlPlane(
  env: DeploymentControlPlaneEnv,
): DeploymentControlPlane {
  const root = mkdtempSync(join(tmpdir(), "oma-egress-models-"));
  tempRoots.push(root);
  return createRawDeploymentControlPlane({ OMA_HOME: root, ...env });
}

// A real deployment control plane in durable + api-key mode with an egress
// sidecar image and a master key — the ONLY configuration in which a secrets
// store is allowed to exist (app.ts guards secrets ⇒ api-key ⇒ durable).
// Returns a minted workspace key to authenticate requests.
function makeDurableEgressPlane(): DeploymentControlPlane & { key: string } {
  const root = mkdtempSync(join(tmpdir(), "oma-egress-plane-"));
  tempRoots.push(root);
  const plane = createDeploymentControlPlane({
    OMA_SQLITE_PATH: join(root, "oma.sqlite"),
    OMA_FILE_STORAGE_ROOT: join(root, "objects"),
    OMA_AUTH_MODE: "api-key",
    OMA_SANDBOX_PROVIDER: "docker-local",
    OMA_ALLOW_DOCKER_LOCAL: "true",
    OMA_ENABLE_EGRESS: "true",
    OMA_EGRESS_SIDECAR_IMAGE: "oma-appliance:test",
    OMA_MASTER_KEY: generateMasterKey(),
  });
  const key = plane.stores.workspaces.mintKey("wrk_default", "test").plaintextKey;
  return { ...plane, key };
}

describe("createSessionEgressBundleResolver", () => {
  it("returns undefined for absent and hosted-empty networking, but rejects unrestricted legacy rows", async () => {
    const fixture = makeResolverFixture();
    const plain = fixture.seedSession({ type: "cloud" });
    const hostedEmpty = fixture.seedSession({
      type: "cloud",
      networking: { type: "limited", allowed_hosts: [] },
    });
    const unrestricted = fixture.seedSession({
      type: "cloud",
      networking: { type: "unrestricted" },
    });

    await expect(fixture.resolve("wrk_default", plain)).resolves.toBeUndefined();
    await expect(
      fixture.resolve("wrk_default", hostedEmpty),
    ).resolves.toBeUndefined();
    await expect(fixture.resolve("wrk_default", unrestricted)).rejects.toThrow(
      /unrestricted.*not supported/,
    );
    fixture.close();
  });

  it("builds a bundle for a persisted hosted limited environment", async () => {
    const fixture = makeResolverFixture();
    const sessionId = fixture.seedSession({
      networking: {
        type: "limited",
        allowed_hosts: ["API.Example.com", "*.Example.org"],
      },
    });
    const resolved = await fixture.resolve("wrk_default", sessionId);
    expect(resolved).toBeDefined();
    expect(resolved!.bundle.policy).toEqual({
      allow: [
        { host: "api.example.com", port: 443, protocol: "https", opaqueTunnel: false },
        { host: "*.example.org", port: 443, protocol: "https", opaqueTunnel: false },
      ],
      credentials: [],
    });
    fixture.close();
  });

  it("builds a bundle with sentinels and the resolved secret for a granted environment", async () => {
    const fixture = makeResolverFixture();
    fixture.secrets.put("wrk_default", "github", "REAL-TOKEN");
    const sessionId = fixture.seedSession({ networking: GRANTING_NETWORKING });

    const resolved = await fixture.resolve("wrk_default", sessionId);
    expect(resolved).toBeDefined();
    // The sandbox sees a sentinel, never the real value.
    expect(resolved!.sandboxEnv.GITHUB_TOKEN).toMatch(/^oma-sentinel-/);
    expect(resolved!.sandboxEnv.GITHUB_TOKEN).not.toContain("REAL-TOKEN");
    // The bundle (sidecar-only) carries the resolved secret + a URL-safe token.
    expect(resolved!.bundle.secrets).toEqual({ github: "REAL-TOKEN" });
    expect(resolved!.bundle.proxyAuthToken).toMatch(/^[A-Za-z0-9._~-]+$/);
    expect(resolved!.bundle.listenPort).toBeGreaterThan(0);
    // Two sessions never share sentinels or tokens.
    const again = await fixture.resolve("wrk_default", sessionId);
    expect(again!.bundle.proxyAuthToken).not.toBe(resolved!.bundle.proxyAuthToken);
    expect(again!.sandboxEnv.GITHUB_TOKEN).not.toBe(resolved!.sandboxEnv.GITHUB_TOKEN);
    fixture.close();
  });

  it("omits an unrevealable secret from the bundle instead of failing", async () => {
    const fixture = makeResolverFixture();
    const sessionId = fixture.seedSession({ networking: GRANTING_NETWORKING });

    const resolved = await fixture.resolve("wrk_default", sessionId);
    // Secret never seeded: the grant still mints a sentinel but the sidecar
    // map has no value — the proxy strips the header (fail closed, 0117d).
    expect(resolved!.bundle.secrets).toEqual({});
    expect(resolved!.sandboxEnv.GITHUB_TOKEN).toMatch(/^oma-sentinel-/);
    fixture.close();
  });

  it("uses the creation-time environment hint before the session row is committed", async () => {
    const fixture = makeResolverFixture();
    fixture.secrets.put("wrk_default", "github", "REAL-TOKEN");
    const environmentId = fixture.seedEnvironment({
      networking: GRANTING_NETWORKING,
    });

    const resolved = await fixture.resolve("wrk_default", "sesn_precommit", {
      environmentId,
    });

    expect(resolved).toBeDefined();
    expect(resolved!.sandboxEnv.GITHUB_TOKEN).toMatch(/^oma-sentinel-/);
    expect(resolved!.sandboxEnv.GITHUB_TOKEN).not.toContain("REAL-TOKEN");
    expect(resolved!.bundle.secrets).toEqual({ github: "REAL-TOKEN" });
    fixture.close();
  });
});

describe("fail-closed session-create gate", () => {
  it("rejects an egress-granting environment when the deployment cannot honor it", async () => {
    const plane = createDeploymentControlPlane({});
    const env = await createEnvironment(plane.app, {
      networking: { allow: [{ host: "api.github.com", port: 443 }] },
    });
    const res = await createSession(plane.app, env.id);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.message).toContain("cannot honor");
    expect(body.error.message).toContain("OMA_ENABLE_EGRESS");
    plane.stores.close();
  });

  it("keeps absent and hosted-empty networking at default deny", async () => {
    const plane = createDeploymentControlPlane({});
    const configs: JsonObject[] = [
      { type: "cloud" },
      { type: "cloud", networking: { type: "limited", allowed_hosts: [] } },
    ];
    for (const config of configs) {
      const env = await createEnvironment(plane.app, config);
      const res = await createSession(plane.app, env.id);
      expect(res.status, JSON.stringify(config)).toBe(200);
    }
    plane.stores.close();
  });

  it("accepts limited hosted networking and persists its canonical config", async () => {
    const plane = createDeploymentControlPlane({});
    const config = {
      type: "cloud",
      networking: {
        type: "limited",
        allowed_hosts: ["API.Example.com", "*.Example.org"],
        allow_package_managers: false,
        allow_mcp_servers: false,
      },
    } as JsonObject;
    const res = await request(plane.app, "/v1/environments", {
      method: "POST",
      body: { name: "Limited networking", config },
    });
    expect(res.status).toBe(200);
    const environment = (await res.json()) as ManagedAgentsEnvironment;
    expect(environment.config).toEqual({
      ...config,
      networking: {
        type: "limited",
        allowed_hosts: ["api.example.com", "*.example.org"],
        allow_package_managers: false,
        allow_mcp_servers: false,
      },
    });
    const listed = await request(plane.app, "/v1/environments");
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(1);
    plane.stores.close();
  });

  it("rejects a non-empty hosted limited environment when egress cannot be honored", async () => {
    const plane = createDeploymentControlPlane({});
    const env = await createEnvironment(plane.app, {
      networking: { type: "limited", allowed_hosts: ["example.com"] },
    });
    const res = await createSession(plane.app, env.id);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.message).toContain("cannot honor");
    plane.stores.close();
  });

  it("rejects unsupported hosted networking before persisting the environment", async () => {
    const plane = createDeploymentControlPlane({});
    const res = await request(plane.app, "/v1/environments", {
      method: "POST",
      body: {
        name: "Unsupported networking",
        config: { type: "cloud", networking: { type: "unrestricted" } },
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.type).toBe("invalid_request_error");
    const listed = await request(plane.app, "/v1/environments");
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(0);
    plane.stores.close();
  });

  it("rejects a credential-granting environment without a secrets store", async () => {
    const plane = createDeploymentControlPlane({
      OMA_SANDBOX_PROVIDER: "docker-local",
      OMA_ALLOW_DOCKER_LOCAL: "true",
      OMA_ENABLE_EGRESS: "true",
      OMA_EGRESS_SIDECAR_IMAGE: "oma-appliance:test",
    });
    const env = await createEnvironment(plane.app, {
      networking: GRANTING_NETWORKING,
    });
    const res = await createSession(plane.app, env.id);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.message).toContain("no secrets store");
    expect(body.error.message).toContain("OMA_MASTER_KEY");
    plane.stores.close();
  });

  it("admits a credential-granting environment when egress and secrets are wired", async () => {
    const plane = makeDurableEgressPlane();
    const env = await createEnvironment(
      plane.app,
      { networking: GRANTING_NETWORKING },
      plane.key,
    );
    const res = await createSession(plane.app, env.id, { key: plane.key });
    expect(res.status).toBe(200);
    plane.stores.close();
  });

  it("does not reject egress-granting environments solely because resources are present", async () => {
    const plane = makeDurableEgressPlane();
    const env = await createEnvironment(
      plane.app,
      { networking: GRANTING_NETWORKING },
      plane.key,
    );
    const res = await createSession(plane.app, env.id, {
      key: plane.key,
      resources: [{ type: "file", file_id: "file_x", mount_path: "/mnt/x" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.message).toContain("File file_x not found");
    expect(body.error.message).not.toContain("not yet supported together");
    plane.stores.close();
  });

  it("rejects a malformed egress-shape networking config before persistence", async () => {
    const plane = createDeploymentControlPlane({});
    const res = await request(plane.app, "/v1/environments", {
      method: "POST",
      body: {
        name: "Malformed networking",
        config: {
          type: "cloud",
          networking: { allow: [{ host: "api.github.com", bogus: true }] },
        },
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.message).toContain("Invalid environment networking config");
    const listed = await request(plane.app, "/v1/environments");
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(0);
    plane.stores.close();
  });
});

describe("secrets-store auth guard (Codex adversarial review)", () => {
  // A master key means the deployment handles real credentials; without
  // api-key auth the /v1/secrets API would be unauthenticated on wrk_default.
  // Refuse to boot the dangerous combination rather than warn.
  it("refuses to boot with a master key when auth mode is unset (defaults disabled)", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-guard-"));
    tempRoots.push(root);
    expect(() =>
      createDeploymentControlPlane({
        OMA_SQLITE_PATH: join(root, "oma.sqlite"),
        OMA_FILE_STORAGE_ROOT: join(root, "objects"),
        OMA_MASTER_KEY: generateMasterKey(),
        // OMA_AUTH_MODE deliberately unset -> disabled.
      }),
    ).toThrow("requires OMA_AUTH_MODE=api-key");
  });

  it("refuses to boot with a master key when auth is explicitly disabled", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-guard-"));
    tempRoots.push(root);
    expect(() =>
      createDeploymentControlPlane({
        OMA_SQLITE_PATH: join(root, "oma.sqlite"),
        OMA_FILE_STORAGE_ROOT: join(root, "objects"),
        OMA_AUTH_MODE: "disabled",
        OMA_MASTER_KEY: generateMasterKey(),
      }),
    ).toThrow("requires OMA_AUTH_MODE=api-key");
  });

  it("boots with a master key under api-key auth, and the secrets API demands a key", async () => {
    const plane = makeDurableEgressPlane();
    // No x-api-key -> 401, not an unauthenticated wrk_default write.
    const noKey = await request(plane.app, "/v1/secrets", {
      method: "POST",
      body: { name: "github", value: "REAL" },
    });
    expect(noKey.status).toBe(401);
    // With the workspace key -> 201.
    const withKey = await request(plane.app, "/v1/secrets", {
      method: "POST",
      body: { name: "github", value: "REAL" },
      key: plane.key,
    });
    expect(withKey.status).toBe(201);
    plane.stores.close();
  });
});

describe("wired bundle injection e2e (plan 0117e-4, in-process twin of the sidecar)", () => {
  // The real sidecar's SSRF deny (0117b) is absolute — no private-IP upstream,
  // no test override (0117d hardening). So the "upstream saw the REAL token"
  // proof runs the WIRED bundle (real stores -> real resolver) through an
  // in-process proxy built by buildHooksFromBundle — the exact hook code the
  // sidecar runs — against a local HTTPS upstream. The gated Docker test in
  // docker.test.ts proves the sidecar enforces this same bundle at the
  // CONNECT layer; together they cover the wired path end to end.
  it("injects the real secret in scope and denies off-path/off-method sentinels", async () => {
    const work = mkdtempSync(join(tmpdir(), "oma-wired-e2e-"));
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", join(work, "k.pem"), "-out", join(work, "c.pem"),
      "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    ]);
    const upstreamSeen: Array<string | undefined> = [];
    const echo = createHttpsServer(
      { key: readFileSync(join(work, "k.pem")), cert: readFileSync(join(work, "c.pem")) },
      (req, res) => {
        upstreamSeen.push(req.headers.authorization);
        res.end("ok");
      },
    );
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    const echoPort = (echo.address() as { port: number }).port;

    const fixture = makeResolverFixture();
    fixture.secrets.put("wrk_default", "github", "REAL-TOKEN");
    const sessionId = fixture.seedSession({
      networking: {
        allow: [{ host: "localhost", port: echoPort }],
        credentials: [
          {
            secret: "github",
            env: "GITHUB_TOKEN",
            host: "localhost",
            port: echoPort,
            pathPrefix: "/api",
            methods: ["GET"],
            header: "authorization",
          },
        ],
      },
    });
    const resolved = (await fixture.resolve("wrk_default", sessionId))!;
    const sentinel = resolved.sandboxEnv.GITHUB_TOKEN!;

    const ca = createMitmCA({});
    const proxy = createEgressProxy({
      ...buildHooksFromBundle(resolved.bundle),
      mitmCA: ca,
      tlsTerminateUpstreamCA: readFileSync(join(work, "c.pem")),
      proxyAuthToken: resolved.bundle.proxyAuthToken,
      dangerouslyAllowPrivateAddressesForTest: true,
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const proxyPort = (proxy.address() as { port: number }).port;
    const token = resolved.bundle.proxyAuthToken;

    try {
      // In scope: the agent sends the sentinel; the upstream sees the REAL
      // token; neither the sentinel nor the secret round-trips to the agent.
      const inScope = await tunnelRequest({
        proxyPort, host: "localhost", port: echoPort, ca: ca.certPem,
        headers: { Authorization: `Bearer ${sentinel}` },
        token, path: "/api/data",
      });
      expect(inScope.httpStatus).toBe(200);
      expect(upstreamSeen.at(-1)).toBe("Bearer REAL-TOKEN");

      // Off-path: the sentinel cannot be steered to an ungranted endpoint.
      const offPath = await tunnelRequest({
        proxyPort, host: "localhost", port: echoPort, ca: ca.certPem,
        headers: { Authorization: `Bearer ${sentinel}` },
        token, path: "/other",
      });
      expect(offPath.httpStatus).toBe(403);

      // Off-method: same grant, wrong verb.
      const offMethod = await tunnelRequest({
        proxyPort, host: "localhost", port: echoPort, ca: ca.certPem,
        headers: { Authorization: `Bearer ${sentinel}` },
        token, path: "/api/data", method: "POST",
      });
      expect(offMethod.httpStatus).toBe(403);

      // Only the in-scope request ever reached the upstream.
      expect(upstreamSeen).toHaveLength(1);
      expect(upstreamSeen[0]).not.toContain(sentinel);
    } finally {
      await new Promise<void>((r) => proxy.close(() => r()));
      await new Promise<void>((r) => echo.close(() => r()));
      await disposeMitmCA(ca);
      rmSync(work, { recursive: true, force: true });
      fixture.close();
    }
  });
});

// --- resolver fixture -------------------------------------------------------

function makeResolverFixture() {
  const db = new DatabaseSync(":memory:");
  const sessions = new SqliteSessionStore(db);
  const environments = new SqliteEnvironmentStore(db);
  const secrets = new SqliteSecretsStore(
    db,
    parseMasterKey(generateMasterKey(), "test"),
  );
  const resolve = createSessionEgressBundleResolver({
    sessions,
    environments,
    secrets,
  });
  let seq = 0;
  const seedEnvironment = (config: JsonObject): string => {
    const now = new Date().toISOString();
    const envId = `env_wire_${seq}`;
    seq += 1;
    environments.create({
      row: {
        id: envId,
        workspace_id: "wrk_default",
        type: "environment",
        name: `wiring ${envId}`,
        config,
        created_at: now,
        updated_at: now,
        archived_at: null,
      },
    });
    return envId;
  };
  const seedSession = (config: JsonObject): string => {
    const now = new Date().toISOString();
    const envId = seedEnvironment(config);
    const sessionId = `sesn_wire_${seq}`;
    seq += 1;
    const row: SessionRow = {
      id: sessionId,
      workspace_id: "wrk_default",
      type: "session",
      agent: { type: "agent", id: "agent_seed", version: 1 },
      environment_id: envId,
      status: "idle",
      title: null,
      metadata: {},
      created_at: now,
      updated_at: now,
      archived_at: null,
      usage: null,
      resources: [],
    };
    sessions.create({ row });
    return sessionId;
  };
  return {
    resolve,
    secrets,
    seedEnvironment,
    seedSession,
    close: () => db.close(),
  };
}

// --- API helpers ------------------------------------------------------------

type TestApp = {
  request: (path: string, init?: RequestInit) => Promise<Response> | Response;
};

async function createEnvironment(
  app: TestApp,
  config: JsonObject,
  key?: string,
): Promise<ManagedAgentsEnvironment> {
  const res = await request(app, "/v1/environments", {
    method: "POST",
    body: { name: "egress wiring env", config: { type: "cloud", ...config } },
    key,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsEnvironment;
}

async function createSession(
  app: TestApp,
  environmentId: string,
  opts: { key?: string; resources?: unknown[] } = {},
): Promise<Response> {
  const agentRes = await request(app, "/v1/agents", {
    method: "POST",
    body: {
      name: "egress wiring agent",
      model: "claude-opus-4-7",
      tools: [{ type: "agent_toolset_20260401" }],
    },
    key: opts.key,
  });
  expect(agentRes.status).toBe(200);
  const agent = (await agentRes.json()) as ManagedAgentsAgent;
  return request(app, "/v1/sessions", {
    method: "POST",
    body: {
      agent: agent.id,
      environment_id: environmentId,
      ...(opts.resources === undefined ? {} : { resources: opts.resources }),
    },
    key: opts.key,
  });
}

function request(
  app: TestApp,
  path: string,
  opts: { method?: string; body?: unknown; key?: string } = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: opts.method ?? "GET",
      headers: {
        "anthropic-beta": MANAGED_AGENTS_BETA,
        ...(opts.key === undefined ? {} : { "x-api-key": opts.key }),
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
  );
}
