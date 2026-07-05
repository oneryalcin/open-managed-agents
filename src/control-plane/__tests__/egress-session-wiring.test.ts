// Plan 0117e-3: the session-path egress wiring. Two properties under test:
// (1) the per-session bundle resolver maps environment networking config into
// a sidecar bundle (or undefined — default deny), and (2) the fail-closed
// session-create gate rejects egress-granting environments the deployment
// cannot honor, while hosted-shape networking keeps today's behavior.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createDeploymentControlPlane,
  createSessionEgressBundleResolver,
} from "../app.ts";
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

describe("createSessionEgressBundleResolver", () => {
  it("returns undefined for absent and hosted-shape networking", async () => {
    const fixture = makeResolverFixture();
    const plain = fixture.seedSession({ type: "cloud" });
    const unrestricted = fixture.seedSession({
      type: "cloud",
      networking: { type: "unrestricted" },
    });

    await expect(fixture.resolve("wrk_default", plain)).resolves.toBeUndefined();
    await expect(
      fixture.resolve("wrk_default", unrestricted),
    ).resolves.toBeUndefined();
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

  it("keeps hosted-shape and absent networking creating sessions as before", async () => {
    const plane = createDeploymentControlPlane({});
    const configs: JsonObject[] = [
      { type: "cloud" },
      { type: "cloud", networking: { type: "unrestricted" } },
    ];
    for (const config of configs) {
      const env = await createEnvironment(plane.app, config);
      const res = await createSession(plane.app, env.id);
      expect(res.status, JSON.stringify(config)).toBe(200);
    }
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
    const plane = createDeploymentControlPlane({
      OMA_SANDBOX_PROVIDER: "docker-local",
      OMA_ALLOW_DOCKER_LOCAL: "true",
      OMA_ENABLE_EGRESS: "true",
      OMA_EGRESS_SIDECAR_IMAGE: "oma-appliance:test",
      OMA_MASTER_KEY: generateMasterKey(),
    });
    const env = await createEnvironment(plane.app, {
      networking: GRANTING_NETWORKING,
    });
    const res = await createSession(plane.app, env.id);
    expect(res.status).toBe(200);
    plane.stores.close();
  });

  it("rejects a malformed egress-shape networking config at session create", async () => {
    const plane = createDeploymentControlPlane({});
    const env = await createEnvironment(plane.app, {
      networking: { allow: [{ host: "api.github.com", bogus: true }] },
    });
    const res = await createSession(plane.app, env.id);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.message).toContain("invalid networking config");
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
  const seedSession = (config: JsonObject): string => {
    const now = new Date().toISOString();
    const envId = `env_wire_${seq}`;
    const sessionId = `sesn_wire_${seq}`;
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
    seedSession,
    close: () => db.close(),
  };
}

// --- API helpers ------------------------------------------------------------

async function createEnvironment(
  app: { request: (path: string, init?: RequestInit) => Promise<Response> | Response },
  config: JsonObject,
): Promise<ManagedAgentsEnvironment> {
  const res = await request(app, "/v1/environments", {
    method: "POST",
    body: { name: "egress wiring env", config: { type: "cloud", ...config } },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsEnvironment;
}

async function createSession(
  app: { request: (path: string, init?: RequestInit) => Promise<Response> | Response },
  environmentId: string,
): Promise<Response> {
  const agentRes = await request(app, "/v1/agents", {
    method: "POST",
    body: {
      name: "egress wiring agent",
      model: "claude-opus-4-7",
      tools: [{ type: "agent_toolset_20260401" }],
    },
  });
  expect(agentRes.status).toBe(200);
  const agent = (await agentRes.json()) as ManagedAgentsAgent;
  return request(app, "/v1/sessions", {
    method: "POST",
    body: { agent: agent.id, environment_id: environmentId },
  });
}

function request(
  app: { request: (path: string, init?: RequestInit) => Promise<Response> | Response },
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: opts.method ?? "GET",
      headers: {
        "anthropic-beta": MANAGED_AGENTS_BETA,
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
  );
}
