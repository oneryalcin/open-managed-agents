import { describe, expect, it } from "vitest";
import { createDeploymentControlPlaneApp } from "./helpers.ts";
import { createDeploymentControlPlane, MANAGED_AGENTS_BETA } from "../app.ts";
import { generateMasterKey } from "../secrets/master-key.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDeploymentPiSessionRunner,
  parseDeploymentRuntimeConfigFromEnv,
  validateDeploymentRuntimeConfig,
} from "../deployment-runtime-config.ts";
import type { PiRuntimeSession } from "../sessions/pi/runner.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";

describe("deployment runtime config", () => {
  it("owns MCP background-worker teardown idempotently", async () => {
    const root = mkdtempSync(join(tmpdir(), "oma-mcp-teardown-"));
    try {
      const plane = createDeploymentControlPlane({
        OMA_HOME: root,
        OMA_ENABLE_MCP: "true",
      });
      await plane.close();
      await expect(plane.close()).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("joins a validate refresh into the ticker's in-flight refresh (one coordinator, one POST)", async () => {
    // §7B.5 validate-racing-the-ticker + plan 0124 composition: the ticker
    // and the validate route must share ONE RefreshCoordinator, so their
    // refreshes single-flight into one token-endpoint POST. If app wiring
    // ever gave them separate coordinators, this test sees two POSTs.
    const tokenEndpoint = "http://127.0.0.1:43125/token";
    const rotatedAccess = "rotated-access-0124";
    let tokenPosts = 0;
    let releaseToken!: () => void;
    const tokenGate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    let firstTokenHit!: () => void;
    const tokenHit = new Promise<void>((resolve) => {
      firstTokenHit = resolve;
    });
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).startsWith(tokenEndpoint)) {
        tokenPosts += 1;
        firstTokenHit();
        await tokenGate;
        return new Response(
          JSON.stringify({ access_token: rotatedAccess, expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === `Bearer ${rotatedAccess}`) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as never;
    const root = mkdtempSync(join(tmpdir(), "oma-refresh-race-"));
    const plane = createDeploymentControlPlane(
      {
        OMA_HOME: root,
        OMA_ENABLE_MCP: "true",
        OMA_MASTER_KEY: generateMasterKey(),
        OMA_AUTH_MODE: "api-key",
        OMA_SQLITE_PATH: join(root, "oma.sqlite"),
        OMA_FILE_STORAGE_ROOT: join(root, "objects"),
      },
      {
        testMcp: {
          fetch,
          allowInsecureTokenEndpoint: (url) => url.href === tokenEndpoint,
        },
      },
    );
    const key = plane.stores.workspaces.mintKey("wrk_default", "test").plaintextKey;
    try {
      const vault = await requestJson<{ id: string }>(plane.app, key, "/v1/vaults", {
        display_name: "Race vault",
      });
      const credential = await requestJson<{ id: string }>(
        plane.app,
        key,
        `/v1/vaults/${vault.id}/credentials`,
        {
          display_name: "Race credential",
          auth: {
            type: "mcp_oauth",
            mcp_server_url: "https://mcp.example.com/race",
            access_token: "initial-access-0124",
            expires_at: "2099-12-31T23:59:59Z",
            refresh: {
              refresh_token: "refresh-0124",
              token_endpoint: tokenEndpoint,
              client_id: "client-id",
              token_endpoint_auth: { type: "none" },
            },
          },
        },
      );
      // Backdate the seeded schedule so the row is due, then create a second
      // credential: its onSchedulingChanged hook wakes the sleeping ticker,
      // which finds the due row and starts a refresh into the blocked gate.
      const due = plane.stores.vaults
        .listDueRefreshes("2100-01-01T00:00:00.000Z", 50)
        .find((row) => row.credentialId === credential.id);
      expect(due).toBeDefined();
      plane.stores.vaults.persistOauthRefreshFailure({
        workspaceId: due!.workspaceId,
        vaultId: due!.vaultId,
        credentialId: due!.credentialId,
        expectedAuthVersion: due!.authVersion,
        status: "transient",
        refreshAttempts: 1,
        nextRefreshAt: "1970-01-01T00:00:00.000Z",
      });
      await requestJson(plane.app, key, `/v1/vaults/${vault.id}/credentials`, {
        display_name: "Wake trigger",
        auth: {
          type: "mcp_oauth",
          mcp_server_url: "https://mcp.example.com/wake",
          access_token: "wake-access-0124",
          expires_at: "2099-12-31T23:59:59Z",
          refresh: {
            refresh_token: "wake-refresh-0124",
            token_endpoint: tokenEndpoint,
            client_id: "client-id",
            token_endpoint_auth: { type: "none" },
          },
        },
      });
      await tokenHit;

      // Ticker's refresh is now in flight and blocked. A validate on the same
      // credential must JOIN that flight rather than start its own.
      const validatePromise = plane.app.request(
        `/v1/vaults/${vault.id}/credentials/${credential.id}/mcp_oauth_validate`,
        {
          method: "POST",
          headers: { "anthropic-beta": MANAGED_AGENTS_BETA, "x-api-key": key },
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseToken();
      const validateResponse = await validatePromise;
      expect(validateResponse.status).toBe(200);
      const body = (await validateResponse.json()) as {
        status: string;
        refresh: { status: string };
      };
      expect(body.status).toBe("valid");
      expect(tokenPosts).toBe(1);
    } finally {
      releaseToken();
      await plane.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats absent config as no provider, not host passthrough", () => {
    const config = parseDeploymentRuntimeConfigFromEnv({});

    expect(config).toEqual({});
    expect(() => createDeploymentPiSessionRunner(config)).not.toThrow();
  });

  it("treats explicit none as no provider", () => {
    const config = parseDeploymentRuntimeConfigFromEnv({
      OMA_SANDBOX_PROVIDER: "none",
    });

    expect(config).toEqual({
      sandboxProviderSelection: { type: "none" },
    });
    expect(() => createDeploymentPiSessionRunner(config)).not.toThrow();
  });

  it("rejects malformed provider names at config parsing", () => {
    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "dokcer-local",
      }),
    ).toThrow("Unsupported OMA_SANDBOX_PROVIDER");
  });

  it("dry-runs resolver gates during config parsing", () => {
    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "docker-local",
      }),
    ).toThrow("Docker-local sandbox provider is disabled");

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "host-passthrough",
        OMA_UNSAFE_ALLOW_HOST_PASSTHROUGH: "true",
        OMA_ALLOW_UNSAFE_HOST_PASSTHROUGH: "true",
      }),
    ).toThrow("requires a deployment workspace root");

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "microsandbox-local",
      }),
    ).toThrow("Microsandbox-local sandbox provider is disabled");

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "microsandbox-local",
        OMA_ALLOW_MICROSANDBOX_LOCAL: "true",
      }),
    ).not.toThrow();
  });

  it("resolves docker-local only behind the deployment gate", () => {
    const config = parseDeploymentRuntimeConfigFromEnv({
      OMA_SANDBOX_PROVIDER: "docker-local",
      OMA_ALLOW_DOCKER_LOCAL: "true",
      OMA_SANDBOX_ENV_ALLOWLIST: "PATH,HOME",
      OMA_SANDBOX_OPERATION_TIMEOUT_MS: "2500",
      OMA_DOCKER_REAP_STALE_CONTAINERS_OLDER_THAN_MS: "60000",
    });

    expect(config).toEqual({
      sandboxProviderSelection: {
        type: "docker-local",
        envAllowlist: ["PATH", "HOME"],
        operationTimeoutMs: 2500,
        reapStaleContainersOlderThanMs: 60000,
      },
      sandboxProviderSelectionOptions: {
        allowDockerLocal: true,
      },
    });
    expect(() => createDeploymentPiSessionRunner(config)).not.toThrow();
  });

  it("enables the Docker-local orphan reaper by default", () => {
    const config = parseDeploymentRuntimeConfigFromEnv({
      OMA_SANDBOX_PROVIDER: "docker-local",
      OMA_ALLOW_DOCKER_LOCAL: "true",
    });

    expect(config.sandboxProviderSelection).toEqual({
      type: "docker-local",
      reapStaleContainersOlderThanMs: 86_400_000,
    });
  });

  it("resolves microsandbox-local only behind the deployment gate", () => {
    const config = parseDeploymentRuntimeConfigFromEnv({
      OMA_SANDBOX_PROVIDER: "microsandbox-local",
      OMA_ALLOW_MICROSANDBOX_LOCAL: "true",
      OMA_SANDBOX_OPERATION_TIMEOUT_MS: "2500",
      OMA_MICROSANDBOX_REAP_STALE_SANDBOXES_OLDER_THAN_MS: "60000",
    });

    expect(config).toEqual({
      sandboxProviderSelection: {
        type: "microsandbox-local",
        operationTimeoutMs: 2500,
        reapStaleSandboxesOlderThanMs: 60000,
      },
      sandboxProviderSelectionOptions: {
        allowMicrosandboxLocal: true,
      },
    });
    expect(() => createDeploymentPiSessionRunner(config)).not.toThrow();
  });

  it("enables egress only with both the flag and the sidecar image", () => {
    const config = parseDeploymentRuntimeConfigFromEnv({
      OMA_SANDBOX_PROVIDER: "docker-local",
      OMA_ALLOW_DOCKER_LOCAL: "true",
      OMA_ENABLE_EGRESS: "true",
      OMA_EGRESS_SIDECAR_IMAGE: "oma-appliance:test",
      OMA_EGRESS_SIDECAR_REPO_MOUNT: "/repo",
    });
    expect(config.egress).toEqual({
      sidecarImage: "oma-appliance:test",
      sidecarRepoMount: "/repo",
    });

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "docker-local",
        OMA_ALLOW_DOCKER_LOCAL: "true",
        OMA_ENABLE_EGRESS: "true",
      }),
    ).toThrow("OMA_ENABLE_EGRESS=true requires OMA_EGRESS_SIDECAR_IMAGE");
  });

  it("rejects a sidecar image that would silently change nothing", () => {
    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "docker-local",
        OMA_ALLOW_DOCKER_LOCAL: "true",
        OMA_EGRESS_SIDECAR_IMAGE: "oma-appliance:test",
      }),
    ).toThrow("OMA_EGRESS_SIDECAR_IMAGE is ignored without OMA_ENABLE_EGRESS=true");
  });

  it("rejects a sidecar repo mount without the enable flag", () => {
    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "docker-local",
        OMA_ALLOW_DOCKER_LOCAL: "true",
        OMA_EGRESS_SIDECAR_REPO_MOUNT: "/repo",
      }),
    ).toThrow("OMA_EGRESS_SIDECAR_REPO_MOUNT is ignored without OMA_ENABLE_EGRESS=true");
  });

  it("rejects egress env on non-docker providers", () => {
    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "microsandbox-local",
        OMA_ALLOW_MICROSANDBOX_LOCAL: "true",
        OMA_ENABLE_EGRESS: "true",
      }),
    ).toThrow("OMA_ENABLE_EGRESS is ignored by OMA_SANDBOX_PROVIDER=microsandbox-local");

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_EGRESS_SIDECAR_IMAGE: "oma-appliance:test",
      }),
    ).toThrow("OMA_EGRESS_SIDECAR_IMAGE is ignored by set OMA_SANDBOX_PROVIDER first");
  });

  it("fails runner construction when egress is enabled without a bundle resolver", () => {
    const config = parseDeploymentRuntimeConfigFromEnv({
      OMA_SANDBOX_PROVIDER: "docker-local",
      OMA_ALLOW_DOCKER_LOCAL: "true",
      OMA_ENABLE_EGRESS: "true",
      OMA_EGRESS_SIDECAR_IMAGE: "oma-appliance:test",
    });
    expect(() => createDeploymentPiSessionRunner(config)).toThrow(
      "egress is enabled but no egress bundle resolver was provided",
    );
    expect(() =>
      createDeploymentPiSessionRunner(config, {
        resolveEgressBundle: async () => undefined,
      }),
    ).not.toThrow();
  });

  it("does not let runner construction options replace deployment provider config", () => {
    expect(() =>
      createDeploymentPiSessionRunner(
        {},
        { sandboxProviderSelection: { type: "docker-local" } } as never,
      ),
    ).toThrow("cannot override sandbox provider config");
  });

  it("requires both passthrough gates in trusted deployment config", () => {
    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "host-passthrough",
        OMA_UNSAFE_ALLOW_HOST_PASSTHROUGH: "true",
        OMA_HOST_PASSTHROUGH_WORKSPACE_ROOT: "/tmp/open-managed-agents",
      }),
    ).toThrow("Host passthrough provider is disabled");

    const config = parseDeploymentRuntimeConfigFromEnv({
      OMA_SANDBOX_PROVIDER: "host-passthrough",
      OMA_UNSAFE_ALLOW_HOST_PASSTHROUGH: "true",
      OMA_ALLOW_UNSAFE_HOST_PASSTHROUGH: "true",
      OMA_HOST_PASSTHROUGH_WORKSPACE_ROOT: "/tmp/open-managed-agents",
      OMA_SANDBOX_ENV_ALLOWLIST: "PATH",
    });

    expect(config).toEqual({
      sandboxProviderSelection: {
        type: "host-passthrough",
        unsafeAllowHostPassthrough: true,
        envAllowlist: ["PATH"],
      },
      sandboxProviderSelectionOptions: {
        allowUnsafeHostPassthrough: true,
        hostPassthroughWorkspaceRoot: "/tmp/open-managed-agents",
      },
    });
  });

  it("rejects provider-specific fields that would otherwise be accepted but ignored", () => {
    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_ALLOW_DOCKER_LOCAL: "true",
      }),
    ).toThrow("OMA_ALLOW_DOCKER_LOCAL is ignored");

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_DOCKER_REAP_STALE_CONTAINERS_OLDER_THAN_MS: "60000",
      }),
    ).toThrow("OMA_DOCKER_REAP_STALE_CONTAINERS_OLDER_THAN_MS is ignored");

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_ALLOW_MICROSANDBOX_LOCAL: "true",
      }),
    ).toThrow("OMA_ALLOW_MICROSANDBOX_LOCAL is ignored");

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_MICROSANDBOX_REAP_STALE_SANDBOXES_OLDER_THAN_MS: "60000",
      }),
    ).toThrow(
      "OMA_MICROSANDBOX_REAP_STALE_SANDBOXES_OLDER_THAN_MS is ignored",
    );

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_OPERATION_TIMEOUT_MS: "2500",
      }),
    ).toThrow("OMA_SANDBOX_OPERATION_TIMEOUT_MS is ignored");

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "none",
        OMA_SANDBOX_ENV_ALLOWLIST: "PATH",
      }),
    ).toThrow("OMA_SANDBOX_ENV_ALLOWLIST requires");

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "docker-local",
        OMA_ALLOW_DOCKER_LOCAL: "true",
        OMA_HOST_PASSTHROUGH_WORKSPACE_ROOT: "/tmp",
      }),
    ).toThrow("OMA_HOST_PASSTHROUGH_WORKSPACE_ROOT is ignored");

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "host-passthrough",
        OMA_UNSAFE_ALLOW_HOST_PASSTHROUGH: "true",
        OMA_ALLOW_UNSAFE_HOST_PASSTHROUGH: "true",
        OMA_HOST_PASSTHROUGH_WORKSPACE_ROOT: "/tmp",
        OMA_DOCKER_REAP_STALE_CONTAINERS_OLDER_THAN_MS: "60000",
      }),
    ).toThrow("OMA_DOCKER_REAP_STALE_CONTAINERS_OLDER_THAN_MS is ignored");

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "docker-local",
        OMA_ALLOW_DOCKER_LOCAL: "true",
        OMA_MICROSANDBOX_REAP_STALE_SANDBOXES_OLDER_THAN_MS: "60000",
      }),
    ).toThrow(
      "OMA_MICROSANDBOX_REAP_STALE_SANDBOXES_OLDER_THAN_MS is ignored",
    );

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "microsandbox-local",
        OMA_ALLOW_MICROSANDBOX_LOCAL: "true",
        OMA_SANDBOX_ENV_ALLOWLIST: "PATH",
      }),
    ).toThrow("OMA_SANDBOX_ENV_ALLOWLIST requires");

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "microsandbox-local",
        OMA_ALLOW_MICROSANDBOX_LOCAL: "true",
        OMA_ALLOW_DOCKER_LOCAL: "true",
      }),
    ).toThrow("OMA_ALLOW_DOCKER_LOCAL is ignored");

    expect(() =>
      validateDeploymentRuntimeConfig({
        sandboxProviderSelectionOptions: { allowDockerLocal: true },
      }),
    ).toThrow("allowDockerLocal is ignored by no provider");

    expect(() =>
      validateDeploymentRuntimeConfig({
        sandboxProviderSelection: { type: "docker-local" },
        sandboxProviderSelectionOptions: {
          allowDockerLocal: true,
          allowUnsafeHostPassthrough: true,
        },
      }),
    ).toThrow("allowUnsafeHostPassthrough is ignored by docker-local");

    expect(() =>
      validateDeploymentRuntimeConfig({
        sandboxProviderSelectionOptions: { allowMicrosandboxLocal: true },
      }),
    ).toThrow("allowMicrosandboxLocal is ignored by no provider");

    expect(() =>
      validateDeploymentRuntimeConfig({
        sandboxProviderSelection: { type: "docker-local" },
        sandboxProviderSelectionOptions: {
          allowDockerLocal: true,
          allowMicrosandboxLocal: true,
        },
      }),
    ).toThrow("allowMicrosandboxLocal is ignored by docker-local");

    expect(() =>
      validateDeploymentRuntimeConfig({
        sandboxProviderSelection: { type: "microsandbox-local" },
        sandboxProviderSelectionOptions: {
          allowMicrosandboxLocal: true,
          hostPassthroughWorkspaceRoot: "/tmp",
        },
      }),
    ).toThrow("hostPassthroughWorkspaceRoot is ignored by microsandbox-local");
  });

  it("rejects non-strict deployment values", () => {
    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "docker-local",
        OMA_ALLOW_DOCKER_LOCAL: "yes",
      }),
    ).toThrow('OMA_ALLOW_DOCKER_LOCAL must be "true" or "false"');

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "docker-local",
        OMA_ALLOW_DOCKER_LOCAL: "true",
        OMA_SANDBOX_OPERATION_TIMEOUT_MS: "2.5",
      }),
    ).toThrow("OMA_SANDBOX_OPERATION_TIMEOUT_MS must be a positive integer");

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "docker-local",
        OMA_ALLOW_DOCKER_LOCAL: "true",
        OMA_DOCKER_REAP_STALE_CONTAINERS_OLDER_THAN_MS: "0",
      }),
    ).toThrow(
      "OMA_DOCKER_REAP_STALE_CONTAINERS_OLDER_THAN_MS must be a positive integer",
    );

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "microsandbox-local",
        OMA_ALLOW_MICROSANDBOX_LOCAL: "yes",
      }),
    ).toThrow('OMA_ALLOW_MICROSANDBOX_LOCAL must be "true" or "false"');

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "microsandbox-local",
        OMA_ALLOW_MICROSANDBOX_LOCAL: "true",
        OMA_SANDBOX_OPERATION_TIMEOUT_MS: "2.5",
      }),
    ).toThrow("OMA_SANDBOX_OPERATION_TIMEOUT_MS must be a positive integer");

    expect(() =>
      parseDeploymentRuntimeConfigFromEnv({
        OMA_SANDBOX_PROVIDER: "microsandbox-local",
        OMA_ALLOW_MICROSANDBOX_LOCAL: "true",
        OMA_MICROSANDBOX_REAP_STALE_SANDBOXES_OLDER_THAN_MS: "0",
      }),
    ).toThrow(
      "OMA_MICROSANDBOX_REAP_STALE_SANDBOXES_OLDER_THAN_MS must be a positive integer",
    );
  });

  it("deployment app fails provider gates at construction", () => {
    expect(() =>
      createDeploymentControlPlaneApp({
        OMA_SANDBOX_PROVIDER: "docker-local",
      }),
    ).toThrow("Docker-local sandbox provider is disabled");
  });

  it("deployment app injects the configured runtime into served sessions", async () => {
    const factory = new FakeSessionFactory();
    const app = createDeploymentControlPlaneApp(
      { OMA_SANDBOX_PROVIDER: "none" },
      {
        runner: {
          sessionFactory: () => factory.create(),
          idleTtlMs: 0,
        },
      },
    );
    const agent = await createAgent(app);
    const environment = await createEnvironment(app);
    const session = await createSession(app, {
      agent: agent.id,
      environment_id: environment.id,
    });

    await sendMessage(app, session.id, "hello");
    const events = await getEvents(app, session.id);

    expect(factory.sessions).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual([
      "user.message",
      "agent.message",
    ]);
    expect(events[1]?.content).toEqual([
      { type: "text", text: "runtime: hello" },
    ]);
  });
});

async function requestJson<T = unknown>(
  app: ReturnType<typeof createDeploymentControlPlane>["app"],
  key: string,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-beta": MANAGED_AGENTS_BETA,
      "x-api-key": key,
    },
    body: JSON.stringify(body),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
}

class FakeSessionFactory {
  readonly sessions: FakeSession[] = [];

  async create(): Promise<FakeSession> {
    const session = new FakeSession();
    this.sessions.push(session);
    return session;
  }
}

class FakeSession implements PiRuntimeSession {
  private readonly listeners = new Set<(event: unknown) => void>();

  async prompt(text: string): Promise<void> {
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `runtime: ${text}` }],
        stopReason: "stop",
      },
    });
  }

  async followUp(_text: string): Promise<void> {}

  async abort(): Promise<void> {}

  dispose(): void {
    this.listeners.clear();
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getActiveToolNames(): string[] {
    return [];
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }
}

async function createAgent(
  app: ReturnType<typeof createDeploymentControlPlaneApp>,
): Promise<ManagedAgentsAgent> {
  const res = await app.request("/v1/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Deployment Runtime Agent",
      model: "claude-opus-4-7",
      tools: [{ type: "agent_toolset_20260401" }],
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsAgent;
}

async function createEnvironment(
  app: ReturnType<typeof createDeploymentControlPlaneApp>,
): Promise<ManagedAgentsEnvironment> {
  const res = await app.request("/v1/environments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Deployment Runtime Environment",
      config: { type: "cloud" },
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsEnvironment;
}

async function createSession(
  app: ReturnType<typeof createDeploymentControlPlaneApp>,
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

async function sendMessage(
  app: ReturnType<typeof createDeploymentControlPlaneApp>,
  sessionId: string,
  text: string,
): Promise<void> {
  const res = await app.request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    }),
  });
  expect(res.status).toBe(200);
}

async function getEvents(
  app: ReturnType<typeof createDeploymentControlPlaneApp>,
  sessionId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await app.request(`/v1/sessions/${sessionId}/events?order=asc`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Array<Record<string, unknown>> }).data;
}
