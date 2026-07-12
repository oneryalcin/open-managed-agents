import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminAuth, loadAdminKey, type AdminAuth } from "./admin/auth.ts";
import { log, parseBooleanFlag, setLogEventHook } from "./logging.ts";
import {
  loadMetricsToken,
  registerObservabilityRoutes,
  sha256Token,
  storageFreeBytes,
  type ObservabilityRoutesConfig,
} from "./observability/routes.ts";
import {
  createControlPlaneMetrics,
  registerProcessGauges,
  type ControlPlaneMetrics,
} from "./observability/instruments.ts";
import {
  CONSOLE_MOUNT,
  registerConsoleRoutes,
  type ConsoleStaticConfig,
} from "./console/static.ts";
import { adminRoutes } from "./admin/routes.ts";
import { DefaultAdminService, type AdminService } from "./admin/service.ts";
import { agentsRoutes } from "./agents/routes.ts";
import { DefaultAgentService } from "./agents/service.ts";
import { SqliteAgentStore } from "./agents/store.ts";
import type { AgentService } from "./agents/types.ts";
import { environmentsRoutes } from "./environments/routes.ts";
import { DefaultEnvironmentService } from "./environments/service.ts";
import { SqliteEnvironmentStore } from "./environments/store.ts";
import type { EnvironmentService } from "./environments/types.ts";
import { sessionEventsRoutes } from "./events/routes.ts";
import { DefaultSessionEventsService } from "./events/service.ts";
import { SessionEventBroadcaster } from "./events/broadcaster.ts";
import { EventStore } from "./events/store.ts";
import { filesRoutes } from "./files/routes.ts";
import { DefaultFileService } from "./files/service.ts";
import { InMemoryFileStorage } from "./files/store.ts";
import type { FileService } from "./files/types.ts";
import { skillsRoutes } from "./skills/routes.ts";
import { DefaultSkillsService } from "./skills/service.ts";
import { InMemorySkillsStore } from "./skills/store.ts";
import type { SkillsService } from "./skills/types.ts";
import { createBestEffortSessionOutputCoordinator } from "./deployment-session-output-coordinator.ts";
import { createBestEffortRuntimeEventCoordinator } from "./deployment-runtime-event-coordinator.ts";
import type {
  RuntimeEventRunner,
  RuntimeEventTranslator,
  SessionEventsService,
} from "./events/types.ts";
import {
  createDeploymentPiSessionRunner,
  parseDeploymentRuntimeConfigFromEnv,
  type DeploymentPiSessionRunnerOptions,
  type DeploymentRuntimeEnv,
} from "./deployment-runtime-config.ts";
import {
  createDeploymentStoresFromEnv,
  type DeploymentStorageEnv,
  type DeploymentStores,
} from "./deployment-storage.ts";
import {
  ApiError,
  type ApiErrorBody,
  authenticationFailed,
  ensureApiError,
  requestTooLarge,
  requestId,
  toApiErrorBody,
} from "./errors.ts";
import type { ControlPlaneRouteEnv, WorkspaceId } from "./workspace.ts";
import {
  createAdmissionLimits,
  parseAdmissionLimitsFromEnv,
  type AdmissionLimits,
  type DeploymentAdmissionEnv,
} from "./admission.ts";
import { secretsRoutes } from "./secrets/routes.ts";
import { DefaultSecretsService, type SecretsService } from "./secrets/service.ts";
import { sessionsRoutes } from "./sessions/routes.ts";
import { DefaultSessionService } from "./sessions/service.ts";
import { SqliteSessionStore } from "./sessions/store.ts";
import type { SessionService } from "./sessions/types.ts";
import { vaultsRoutes } from "./vaults/routes.ts";
import type { McpOauthValidationDependencies } from "./vaults/mcp-oauth-validate.ts";
import { DefaultVaultService } from "./vaults/service.ts";
import { SqliteVaultStore } from "./vaults/store.ts";
import type { VaultService } from "./vaults/types.ts";
import {
  createFileMountResolver,
  createSkillSnapshotsProvider,
  createSessionEgressBundleResolver,
  createStoreBackedCustomToolsProvider,
} from "./wiring.ts";
import { createStoreBackedBuiltinToolAccessResolver } from "./sessions/pi/tool-permissions.ts";
import {
  createStoreBackedMcpCredentialResolver,
  createStoreBackedMcpServersProvider,
  createStoreBackedMcpToolAccessResolver,
} from "./sessions/pi/mcp/bridge.ts";
import { createDefaultMcpRuntime } from "./sessions/pi/mcp/runtime.ts";
import { DEFAULT_MCP_OPERATION_TIMEOUT_MS } from "./sessions/pi/mcp/client.ts";
import { createOauthRefreshTicker } from "./vaults/oauth-refresh-ticker.ts";
import type { WakeLoop } from "./wake-loop.ts";
import { translatePiEvent } from "./sessions/pi/translator.ts";

export const MAX_REQUEST_BODY_BYTES = 1_048_576;
export const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
export const FILES_API_BETA = "files-api-2025-04-14";
export const SKILLS_API_BETA = "skills-2025-10-02";

type AppEnv = ControlPlaneRouteEnv;

export interface ControlPlaneAuth {
  authenticate(plaintextKey: string): WorkspaceId | undefined;
}

export interface ControlPlaneServices {
  admin?: {
    service: AdminService;
    auth: AdminAuth;
  };
  // Absent = no console shipped alongside this process (in-memory test
  // assemblies); the deployment assembly passes the bundled ui/ dir.
  console?: ConsoleStaticConfig;
  agents: AgentService;
  environments: EnvironmentService;
  files?: FileService;
  skills?: SkillsService;
  // Absent = no secrets backend wired; the routes still register and return
  // the clear "requires a master key" 400 (never a confusing 404).
  secrets?: SecretsService;
  vaults?: VaultService;
  mcp?: McpOauthValidationDependencies;
  sessions: SessionService;
  sessionEvents: SessionEventsService;
  auth?: ControlPlaneAuth;
  admission?: AdmissionLimits;
  // 0121 C2. Absent = no /health, no /metrics, no HTTP metrics middleware
  // (in-memory test assemblies see no change). The deployment assembly
  // always passes health; metrics only when the exposure matrix allows.
  observability?: AppObservability;
}

export interface AppObservability {
  health: ObservabilityRoutesConfig["health"];
  /** Absent = no instrumentation and no /metrics (fail-closed). */
  metrics?: ControlPlaneMetrics;
  /** Bearer requirement for /metrics; absent = unauthenticated (loopback). */
  metricsTokenSha256?: Buffer;
}

export interface InMemoryControlPlaneAppOptions {
  runtime?: {
    runner: RuntimeEventRunner;
    translate: RuntimeEventTranslator;
  };
}

export interface DeploymentControlPlaneAppOptions {
  runner?: DeploymentPiSessionRunnerOptions;
  /** Hermetic-test seam; the appliance entrypoint never supplies it. */
  testMcp?: {
    fetch?: McpOauthValidationDependencies["fetch"];
    allowInsecureTokenEndpoint?: (url: URL) => boolean;
  };
}

export type DeploymentAuthMode = "api-key" | "disabled";

export interface DeploymentAuthEnv {
  OMA_AUTH_MODE?: string;
  OMA_ADMIN_KEY?: string;
  OMA_ADMIN_KEY_FILE?: string;
  /** Bind address (set by the appliance entrypoint; undefined = loopback default). */
  OMA_HOST?: string;
  /** "1" = a TLS terminator fronts this process (operator's assertion). */
  OMA_TLS_TERMINATED?: string;
  /** "1" = consciously accept API keys over a plaintext non-loopback bind. */
  OMA_ALLOW_INSECURE_TRANSPORT?: string;
}

export interface DeploymentObservabilityEnv {
  /** "0" disables /metrics everywhere; default on (subject to the exposure matrix). */
  OMA_METRICS?: string;
  OMA_METRICS_TOKEN?: string;
  OMA_METRICS_TOKEN_FILE?: string;
}

export type DeploymentControlPlaneEnv =
  DeploymentRuntimeEnv &
  DeploymentStorageEnv &
  DeploymentAuthEnv &
  DeploymentAdmissionEnv &
  DeploymentObservabilityEnv;

// 0113 D5: exactly two values; unset stays disabled for the currently allowed
// rollout tiers but warns loudly; anything else fails construction.
export function parseDeploymentAuthMode(
  env: DeploymentAuthEnv,
  opts: { warn?: (message: string) => void } = {},
): DeploymentAuthMode {
  const raw = env.OMA_AUTH_MODE;
  if (raw === undefined) {
    (opts.warn ?? ((message: string) => log.warn("auth_mode_disabled", { detail: message })))(
      "OMA_AUTH_MODE is unset; workspace authentication is DISABLED and all requests resolve to wrk_default. Set OMA_AUTH_MODE=api-key for any deployment beyond trusted single-node.",
    );
    return "disabled";
  }
  const mode = raw.trim();
  if (mode === "api-key" || mode === "disabled") {
    return mode;
  }
  throw new Error(
    `Unsupported OMA_AUTH_MODE: ${JSON.stringify(raw)} (expected "api-key" or "disabled")`,
  );
}

export function createControlPlaneApp(services: ControlPlaneServices): Hono<AppEnv> {
  if (services.admin && !services.auth) {
    throw new Error("Admin API requires workspace authentication to be enabled");
  }
  const app = new Hono<AppEnv>();
  const defaultBodyLimit = bodyLimit({
    maxSize: MAX_REQUEST_BODY_BYTES,
    onError: (c) => {
      const err = requestTooLarge();
      return withAdminNoStore(
        c.req.path,
        jsonError(toApiErrorBody(err, c.get("requestId")), err.status),
      );
    },
  });

  // Metrics middleware registers FIRST: a first-registered middleware that
  // awaits next() sees the FINAL response status — including onError-,
  // notFound-, and bodyLimit-produced responses (verified against Hono's
  // compose(); the context is mutated in place). Plan 0121 §2.
  const observedMetrics = services.observability?.metrics;
  if (observedMetrics !== undefined) {
    app.use("*", async (c, next) => {
      const startedAt = performance.now();
      await next();
      const route_class = routeClassForPath(c.req.path);
      observedMetrics.httpRequests.inc({
        route_class,
        method: c.req.method,
        status: String(c.res.status),
      });
      observedMetrics.httpDuration.observe(
        (performance.now() - startedAt) / 1000,
        { route_class },
      );
    });
  }

  app.use("*", async (c, next) => {
    const reqId = requestId();
    c.header("request-id", reqId);
    c.set("requestId", reqId);
    await next();
  });

  // Auth before the beta gate, scoped to known Managed Agents prefixes, per
  // the 0113 hosted probe: unknown paths 404 without touching auth; known
  // paths 401 before beta/version are examined.
  if (services.auth) {
    const auth = services.auth;
    app.use("*", async (c, next) => {
      if (!isManagedAgentsRoute(c.req.path)) {
        await next();
        return;
      }
      const key = c.req.header("x-api-key");
      const workspaceId = key === undefined ? undefined : auth.authenticate(key);
      if (workspaceId === undefined) {
        const err = authenticationFailed();
        return jsonError(toApiErrorBody(err, c.get("requestId")), err.status);
      }
      c.set("workspaceId", workspaceId);
      await next();
    });
  }

  if (services.admin) {
    const adminAuth = services.admin.auth;
    app.use("*", async (c, next) => {
      if (!isAdminRoute(c.req.path)) {
        await next();
        return;
      }
      c.header("cache-control", "no-store");
      const key = c.req.header("x-admin-key");
      if (key === undefined || !adminAuth.verify(key)) {
        const err = authenticationFailed();
        const response = jsonError(
          toApiErrorBody(err, c.get("requestId")),
          err.status,
        );
        response.headers.set("cache-control", "no-store");
        return response;
      }
      await next();
    });
  }

  app.use("*", async (c, next) => {
    const betaFeatures = parseBetaFeatures(c.req.header("anthropic-beta"));
    if (isManagedAgentsRoute(c.req.path) && !hasRequiredBeta(c.req.path, betaFeatures)) {
      const err = new ApiError(404, "not_found_error", "not found");
      return jsonError(toApiErrorBody(err, c.get("requestId")), err.status);
    }
    await next();
  });

  app.use("*", async (c, next) => {
    if (c.req.method === "POST" && (c.req.path === "/v1/files" || c.req.path === "/v1/skills" || /^\/v1\/skills\/[^/]+\/versions$/.test(c.req.path))) {
      await next();
      return;
    }
    return defaultBodyLimit(c, next);
  });

  app.route("/v1/agents", agentsRoutes(services.agents));
  app.route("/v1/environments", environmentsRoutes(services.environments));
  app.route(
    "/v1/files",
    filesRoutes(
      services.files ?? new DefaultFileService(new InMemoryFileStorage()),
      services.admission,
    ),
  );
  app.route(
    "/v1/skills",
    skillsRoutes(
      services.skills ?? new DefaultSkillsService(new InMemorySkillsStore()),
      services.admission,
    ),
  );
  app.route(
    "/v1/secrets",
    secretsRoutes(services.secrets ?? new DefaultSecretsService(undefined)),
  );
  if (services.vaults) {
    app.route("/v1/vaults", vaultsRoutes(services.vaults, services.mcp));
  }
  app.route("/v1/sessions", sessionsRoutes(services.sessions, services.sessionEvents));
  app.route(
    "/v1/sessions/:sessionId/events",
    sessionEventsRoutes(services.sessionEvents, services.admission),
  );
  if (services.admin) {
    app.route("/admin", adminRoutes(services.admin.service));
  }
  if (services.console) {
    registerConsoleRoutes(app, services.console);
  }
  if (services.observability) {
    registerObservabilityRoutes(app, {
      health: services.observability.health,
      ...(services.observability.metrics === undefined
        ? {}
        : {
            metrics: {
              registry: services.observability.metrics.registry,
              ...(services.observability.metricsTokenSha256 === undefined
                ? {}
                : { tokenSha256: services.observability.metricsTokenSha256 }),
            },
          }),
    });
  }

  app.notFound((c) => {
    const err = new ApiError(404, "not_found_error", "Route not found");
    return withAdminNoStore(
      c.req.path,
      jsonError(toApiErrorBody(err, c.get("requestId")), err.status),
    );
  });

  app.onError((error, c) => {
    const err = ensureApiError(error);
    if (err.status >= 500) {
      // 0121 C1: 5xx responses were invisible in logs before this line.
      log.error("request_failed", {
        requestId: c.get("requestId"),
        routeClass: routeClassForPath(c.req.path),
        status: err.status,
        error,
      });
    }
    return withAdminNoStore(
      c.req.path,
      jsonError(
        toApiErrorBody(err, c.get("requestId")),
        err.status,
        err.retryAfterSeconds,
      ),
    );
  });

  return app;
}

export interface DeploymentControlPlane {
  app: Hono<AppEnv>;
  stores: DeploymentStores;
  authMode: DeploymentAuthMode;
  /** Owns background workers and stores; callers must not close stores directly. */
  close(): Promise<void>;
}

export function createDeploymentControlPlaneApp(
  env: DeploymentControlPlaneEnv = process.env,
  opts: DeploymentControlPlaneAppOptions = {},
): Hono<AppEnv> {
  return createDeploymentControlPlane(env, opts, { backgroundWorkers: false }).app;
}

// Same wiring as createDeploymentControlPlaneApp, but hands back the stores
// so a caller that owns the process lifecycle (the appliance entrypoint,
// tests that boot twice against one OMA_HOME) can close them and release the
// .oma.lock instead of leaking them until process exit.
export function createDeploymentControlPlane(
  env: DeploymentControlPlaneEnv = process.env,
  opts: DeploymentControlPlaneAppOptions = {},
  internal: { backgroundWorkers?: boolean } = {},
): DeploymentControlPlane {
  const runtimeConfig = parseDeploymentRuntimeConfigFromEnv(env);
  const authMode = parseDeploymentAuthMode(env);
  const adminKey = loadAdminKey(env);
  // Parsed before any store opens so a malformed flag can't leak a store.
  const tlsTerminated = parseBooleanFlag(env.OMA_TLS_TERMINATED, "OMA_TLS_TERMINATED");
  const allowInsecureTransport = parseBooleanFlag(
    env.OMA_ALLOW_INSECURE_TRANSPORT,
    "OMA_ALLOW_INSECURE_TRANSPORT",
  );
  // 0121 §3.2 exposure matrix, resolved HERE from the configured bind host —
  // the same source of truth as the transport gate below — and passed down
  // as data. Never inferred per-request from headers or socket info. The
  // `?? "1"` is load-bearing: a bare parse would default the flag OFF.
  const metricsEnabled = parseBooleanFlag(env.OMA_METRICS ?? "1", "OMA_METRICS");
  // Token is loaded only when the kill switch is on: OMA_METRICS=0 must be
  // able to recover a deployment whose metrics-secret config is broken
  // (missing token file, both variants set) — C2 review, Codex P2.
  const metricsToken = metricsEnabled ? loadMetricsToken(env) : undefined;
  const metricsServed =
    metricsEnabled && (metricsToken !== undefined || isLoopbackHost(env.OMA_HOST));
  const metrics = metricsServed ? createControlPlaneMetrics() : undefined;
  const admission = createAdmissionLimits(
    parseAdmissionLimitsFromEnv(env),
    metrics === undefined
      ? undefined
      : (limit, status) => metrics.admissionRejections.inc({ limit, status }),
  );
  const stores = createDeploymentStoresFromEnv(env);
  if (authMode === "api-key" && stores.mode !== "durable") {
    stores.close();
    throw new Error(
      "OMA_AUTH_MODE=api-key requires durable deployment storage: set OMA_SQLITE_PATH and OMA_FILE_STORAGE_ROOT. " +
        "In-memory stores are per-process, so no API key could ever be provisioned and every request would fail with 401.",
    );
  }
  // A configured master key means this deployment handles real credentials
  // (secret values + credentialed egress). Without api-key auth every route —
  // including POST/DELETE /v1/secrets — resolves to wrk_default unauthenticated,
  // so anyone who can reach the port could overwrite the credentials the egress
  // proxy injects. Refuse to boot that combination rather than warn (mirrors
  // the api-key-requires-durable guard above); an operator who genuinely wants
  // keyless secrets must not get there by forgetting OMA_AUTH_MODE.
  if (stores.secrets !== undefined && authMode !== "api-key") {
    stores.close();
    throw new Error(
      "A secrets master key (OMA_MASTER_KEY/OMA_MASTER_KEY_FILE) requires OMA_AUTH_MODE=api-key: " +
        "without it the /v1/secrets API is unauthenticated and resolves to wrk_default, so anyone " +
        "reaching the server could read metadata and overwrite the credentials used for egress injection.",
    );
  }
  if (adminKey !== undefined && stores.mode !== "durable") {
    stores.close();
    throw new Error(
      "OMA_ADMIN_KEY/OMA_ADMIN_KEY_FILE requires durable deployment storage: set OMA_SQLITE_PATH and OMA_FILE_STORAGE_ROOT. " +
        "In-memory admin management would not survive restart.",
    );
  }
  if (adminKey !== undefined && authMode !== "api-key") {
    stores.close();
    throw new Error(
      "OMA_ADMIN_KEY/OMA_ADMIN_KEY_FILE requires OMA_AUTH_MODE=api-key: " +
        "the admin API mints workspace keys for /v1 routes, so workspace authentication must be enabled.",
    );
  }
  // 0120 §3.2 (extended after implementation review): every credentialed
  // request — the admin key and each workspace x-api-key — travels in the
  // clear over a plaintext non-loopback bind. Refuse that combination at
  // boot unless the operator asserts a TLS front (OMA_TLS_TERMINATED=1 — an
  // explicit assertion; X-Forwarded-Proto from the request is
  // attacker-suppliable and deliberately not trusted) or consciously opts
  // into plaintext (OMA_ALLOW_INSECURE_TRANSPORT=1, e.g. a Docker bind
  // published only on the host's loopback). Auth-disabled deployments carry
  // no credentials, so they are not gated.
  if (
    authMode === "api-key" &&
    !isLoopbackHost(env.OMA_HOST) &&
    !tlsTerminated &&
    !allowInsecureTransport
  ) {
    stores.close();
    throw new Error(
      `API-key authentication on a non-loopback bind (OMA_HOST=${JSON.stringify(env.OMA_HOST)}) without TLS would send ` +
        "every API key — and the admin key, if set — in cleartext. Either front the appliance with TLS and set " +
        "OMA_TLS_TERMINATED=1, bind to loopback (unset OMA_HOST), or set OMA_ALLOW_INSECURE_TRANSPORT=1 if the " +
        "plaintext exposure is intentional (e.g. a container port published only on the host's loopback).",
    );
  }
  const broadcaster = new SessionEventBroadcaster(stores.events);
  let wakeOauthTicker: () => void = () => undefined;
  const vaultService = new DefaultVaultService(stores.vaults, {
    onSchedulingChanged: () => wakeOauthTicker(),
    ...(opts.testMcp?.allowInsecureTokenEndpoint === undefined
      ? {}
      : {
          allowInsecureTokenEndpoint:
            opts.testMcp.allowInsecureTokenEndpoint,
        }),
  });
  const sandboxProviderName = runtimeConfig.sandboxProviderSelection?.type ?? "none";
  if (metrics !== undefined) {
    // Turn outcomes/durations at the single post-commit chokepoint (plan
    // 0121 §2): the store observer fires after the outermost events-store
    // transaction releases, covering every apply path. archived/deleted are
    // session lifecycle, not turn outcomes — their map entries are dropped
    // without observation, so the map cannot grow unbounded.
    const turnAcceptedAtMs = new Map<string, number>();
    stores.events.setRuntimeChangesObserver((changes) => {
      for (const turn of changes.acceptedTurns ?? []) {
        turnAcceptedAtMs.set(turn.turnId, performance.now());
      }
      for (const closure of changes.closedTurns ?? []) {
        const acceptedAt = turnAcceptedAtMs.get(closure.turnId);
        turnAcceptedAtMs.delete(closure.turnId);
        const outcome = TURN_OUTCOME_BY_REASON[closure.reason];
        if (outcome === undefined) continue;
        metrics.turnsTotal.inc({ outcome });
        if (outcome === "completed" && acceptedAt !== undefined) {
          metrics.turnDuration.observe((performance.now() - acceptedAt) / 1000);
        }
      }
    });
    registerProcessGauges(metrics.registry);
    metrics.registry.gauge(
      "oma_sessions_active",
      "Unarchived sessions (scrape-time count; served by idx_sessions_live).",
      () => stores.sessions.countAllActive(),
    );
    metrics.registry.gauge(
      "oma_runtime_turns_pending",
      "Pending runtime turns awaiting completion (scrape-time count).",
      () => stores.events.countAllPendingRuntimeTurns(),
    );
    metrics.registry.gauge(
      "oma_sse_streams_active",
      "Open SSE event streams.",
      () => admission.sseStreams.totalInFlight,
    );
    setLogEventHook((level) => metrics.logEvents.inc({ level }));
  }
  const mcpRuntime =
    runtimeConfig.mcp !== undefined || opts.runner?.mcp === undefined
      ? createDefaultMcpRuntime(stores.vaults, opts.testMcp?.fetch, {
          onScheduled: () => wakeOauthTicker(),
        })
      : undefined;
  const runner = createDeploymentPiSessionRunner(runtimeConfig, {
    ...opts.runner,
    ...(metrics === undefined
      ? {}
      : {
          onSandboxEvent: (event: "created" | "disposed" | "error") => {
            if (event === "error") {
              metrics.sandboxProviderErrors.inc({ provider: sandboxProviderName });
            } else {
              metrics.sandboxes.inc({ event, provider: sandboxProviderName });
            }
          },
          onSandboxesReaped: (count: number) =>
            metrics.sandboxes.inc(
              { event: "reaped", provider: sandboxProviderName },
              count,
            ),
        }),
    resolveEgressBundle:
      opts.runner?.resolveEgressBundle ??
      createSessionEgressBundleResolver({
        sessions: stores.sessions,
        environments: stores.environments,
        ...(stores.secrets === undefined ? {} : { secrets: stores.secrets }),
      }),
    fileMountResolver: createFileMountResolver(stores.sessions, stores.files),
    skills: createSkillSnapshotsProvider(stores.sessions),
    customTools:
      opts.runner?.customTools ??
      createStoreBackedCustomToolsProvider({
        sessions: stores.sessions,
        agents: stores.agents,
      }),
    builtinToolAccess: createStoreBackedBuiltinToolAccessResolver({
      sessions: stores.sessions,
      agents: stores.agents,
    }),
    // Plan 0122 §4.6: always wired (disabled agents still get their
    // exhausted session.error), dialing gated by OMA_ENABLE_MCP.
    mcp: opts.runner?.mcp ?? {
      enabled: runtimeConfig.mcp !== undefined,
      fetch: mcpRuntime!.fetch,
      servers: createStoreBackedMcpServersProvider({
        sessions: stores.sessions,
        agents: stores.agents,
      }),
      credentials: createStoreBackedMcpCredentialResolver({
        sessions: stores.sessions,
        vaults: vaultService,
        refresh: mcpRuntime!.refreshCoordinator,
      }),
      access: createStoreBackedMcpToolAccessResolver({
        sessions: stores.sessions,
        agents: stores.agents,
      }),
      ...(runtimeConfig.mcp?.operationTimeoutMs === undefined
        ? {}
        : { operationTimeoutMs: runtimeConfig.mcp.operationTimeoutMs }),
      ...(metrics === undefined
        ? {}
        : {
            onToolCall: (
              outcome: "ok" | "error" | "denied" | "timeout" | "aborted",
            ) => metrics.mcpToolCalls.inc({ outcome }),
            onConnection: (
              event: "connected" | "connect_failed" | "auth_failed",
            ) =>
              metrics.mcpConnections.inc({ event }),
          }),
    },
  });
  const runtime = { runner, translate: translatePiEvent };
  const sessionEvents = new DefaultSessionEventsService(
    stores.events,
    stores.sessions,
    broadcaster,
    {
      ...runtime,
      sessionOutputCoordinator: stores.sessionOutputCoordinator,
      runtimeEventCoordinator: stores.runtimeEventCoordinator,
    },
    {
      ...(admission.maxPendingRuntimeTurnsPerWorkspace === undefined
        ? {}
        : {
            maxPendingRuntimeTurnsPerWorkspace:
              admission.maxPendingRuntimeTurnsPerWorkspace,
          }),
      ...(metrics === undefined
        ? {}
        : {
            onAdmissionRejected: () =>
              metrics.admissionRejections.inc({ limit: "turns", status: "429" }),
          }),
    },
  );
  sessionEvents.recoverAllAbandonedRuntimeTurns();
  const consoleRoot = bundledConsoleRoot();
  const app = createControlPlaneApp({
    ...(adminKey === undefined
      ? {}
      : {
          admin: {
            service: new DefaultAdminService(stores.workspaces, stores.vaults),
            auth: createAdminAuth(adminKey),
          },
        }),
    // Secret-free static content, so it serves whenever the dir shipped —
    // deliberately not coupled to admin being enabled (0120 §3.1): a
    // read-only /v1 browser is useful without an admin key.
    ...(consoleRoot === undefined ? {} : { console: { root: consoleRoot } }),
    ...(authMode === "api-key"
      ? { auth: { authenticate: (key: string) => stores.workspaces.authenticate(key) } }
      : {}),
    agents: new DefaultAgentService(stores.agents, stores.skills),
    environments: new DefaultEnvironmentService(stores.environments),
    files: new DefaultFileService(stores.files),
    skills: new DefaultSkillsService(stores.skills),
    secrets: new DefaultSecretsService(stores.secrets),
    vaults: vaultService,
    ...(runtimeConfig.mcp === undefined
      ? {}
      : {
          mcp: {
            fetch: mcpRuntime!.fetch,
            refresh: mcpRuntime!.refreshCoordinator,
            operationTimeoutMs:
              runtimeConfig.mcp.operationTimeoutMs ??
              DEFAULT_MCP_OPERATION_TIMEOUT_MS,
          },
        }),
    sessions: new DefaultSessionService(
      stores.sessions,
      stores.agents,
      stores.environments,
      stores.files,
      {
        assertDeletable: sessionEvents.assertSessionDeletable.bind(sessionEvents),
        runtime: runner,
        skills: stores.skills,
        egressCapability: {
          canHonorNetworking: runtimeConfig.egress !== undefined,
          hasSecretsStore: stores.secrets !== undefined,
        },
        vaults: vaultService,
        deleteSessionRows: stores.sessionCoordinator.deleteSessionRows,
        idempotencyLedger: stores.events,
        createSessionRowsWithIdempotency:
          stores.sessions.createAndCompleteIdempotency.bind(stores.sessions),
        ...(admission.maxActiveSessionsPerWorkspace === undefined
          ? {}
          : {
              maxActiveSessionsPerWorkspace:
                admission.maxActiveSessionsPerWorkspace,
            }),
        ...(metrics === undefined
          ? {}
          : {
              onAdmissionRejected: () =>
                metrics.admissionRejections.inc({
                  limit: "sessions",
                  status: "429",
                }),
            }),
      },
    ),
    sessionEvents,
    admission,
    observability: {
      health: {
        storage:
          stores.mode === "durable"
            ? () => {
                stores.sessions.countAllActive();
                // A configured object root that cannot be statfs'd (deleted,
                // unmounted, permission-broken) is a FAILED check, not a
                // silently-omitted field — C2 review, Codex-adv MEDIUM.
                const free =
                  env.OMA_FILE_STORAGE_ROOT === undefined
                    ? undefined
                    : storageFreeBytes(env.OMA_FILE_STORAGE_ROOT);
                if (env.OMA_FILE_STORAGE_ROOT !== undefined && free === undefined) {
                  return { status: "failed" as const };
                }
                return {
                  status: "ok" as const,
                  ...(free === undefined ? {} : { free_bytes: free }),
                };
              }
            : // In-memory reports its mode rather than lying about durability.
              () => ({ status: "ok" as const, mode: "in-memory" }),
        runtime: () => {
          stores.events.countAllPendingRuntimeTurns();
          return { status: "ok" as const };
        },
      },
      ...(metrics === undefined ? {} : { metrics }),
      ...(metricsToken === undefined
        ? {}
        : { metricsTokenSha256: sha256Token(metricsToken) }),
    },
  });
  const oauthTicker: WakeLoop | undefined =
    runtimeConfig.mcp !== undefined && internal.backgroundWorkers !== false
      ? createOauthRefreshTicker({
          store: stores.vaults,
          refresh: mcpRuntime!.refreshCoordinator,
          onError: (error) => log.error("oauth_refresh_ticker_error", { error }),
        })
      : undefined;
  wakeOauthTicker = () => oauthTicker?.wake();
  let closePromise: Promise<void> | undefined;
  return {
    app,
    stores,
    authMode,
    close() {
      closePromise ??= (async () => {
        await oauthTicker?.close();
        stores.close();
      })();
      return closePromise;
    },
  };
}

// undefined = the appliance's 127.0.0.1 default. Everything not provably
// loopback (0.0.0.0, ::, LAN addresses, hostnames) counts as non-loopback —
// the safe direction for a check that gates a root credential.
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return true;
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// App-root-relative so the same derivation works from a checkout
// (<repo>/ui/…) and inside the Docker image (/app/ui/…, COPY ui ./ui).
function bundledConsoleRoot(): string | undefined {
  const root = fileURLToPath(new URL("../../ui/managed-agents-console", import.meta.url));
  return existsSync(join(root, "index.html")) ? root : undefined;
}

export function createInMemoryControlPlaneApp(
  opts: InMemoryControlPlaneAppOptions = {},
): Hono<AppEnv> {
  const agentStore = SqliteAgentStore.open(":memory:");
  const environmentStore = SqliteEnvironmentStore.open(":memory:");
  const sessionStore = SqliteSessionStore.open(":memory:");
  const vaultStore = SqliteVaultStore.open(":memory:");
  const eventStore = EventStore.open(":memory:");
  const fileStorage = new InMemoryFileStorage();
  const skillsStore = new InMemorySkillsStore();
  const sessionOutputCoordinator = createBestEffortSessionOutputCoordinator({
    sessions: sessionStore,
    events: eventStore,
    files: fileStorage,
  });
  const runtimeEventCoordinator = createBestEffortRuntimeEventCoordinator({
    sessions: sessionStore,
    events: eventStore,
  });
  const broadcaster = new SessionEventBroadcaster(eventStore);
  const vaultService = new DefaultVaultService(vaultStore);
  const sessionEvents = new DefaultSessionEventsService(
    eventStore,
    sessionStore,
    broadcaster,
    opts.runtime
      ? { ...opts.runtime, sessionOutputCoordinator, runtimeEventCoordinator }
      : undefined,
  );
  return createControlPlaneApp({
    agents: new DefaultAgentService(agentStore, skillsStore),
    environments: new DefaultEnvironmentService(environmentStore),
    files: new DefaultFileService(fileStorage),
    skills: new DefaultSkillsService(skillsStore),
    vaults: vaultService,
    sessions: new DefaultSessionService(
      sessionStore,
      agentStore,
      environmentStore,
      fileStorage,
      {
        assertDeletable: sessionEvents.assertSessionDeletable.bind(sessionEvents),
        ...(opts.runtime?.runner ? { runtime: opts.runtime.runner } : {}),
        skills: skillsStore,
        vaults: vaultService,
        idempotencyLedger: eventStore,
        createSessionRowsWithIdempotency:
          sessionStore.createAndCompleteIdempotency.bind(sessionStore),
      },
    ),
    sessionEvents,
  });
}

export function parseBetaFeatures(header: string | undefined): Set<string> {
  return new Set(
    (header ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

function isManagedAgentsRoute(path: string): boolean {
  // Keep this in sync with the Managed Agents route registrations above.
  return [
    "/v1/agents",
    "/v1/environments",
    "/v1/files",
    "/v1/skills",
    // Secrets MUST be auth-gated: leaving it off this list would skip the
    // auth middleware and fall back to wrk_default (plan 0117e-2).
    "/v1/secrets",
    // Vault credentials also carry secret metadata and must not silently bind
    // to wrk_default if someone forgets the auth prefix registration.
    "/v1/vaults",
    "/v1/sessions",
  ].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function isAdminRoute(path: string): boolean {
  return path === "/admin" || path.startsWith("/admin/");
}

// Turn close reasons → metric outcomes (plan 0121 §3.2): archived/deleted
// are session lifecycle, not turn outcomes, and are deliberately unmapped.
const TURN_OUTCOME_BY_REASON: Partial<Record<string, string>> = {
  completed: "completed",
  interrupted: "interrupted",
  terminalized: "abandoned",
};

// Closed enum shared by the request_failed log line and (C2) the HTTP
// metrics middleware — dynamic paths must never reach a metric label.
export type RouteClass = "v1" | "admin" | "console" | "health" | "metrics" | "other";

export function routeClassForPath(path: string): RouteClass {
  if (isManagedAgentsRoute(path)) return "v1";
  if (isAdminRoute(path)) return "admin";
  if (path === CONSOLE_MOUNT || path.startsWith(`${CONSOLE_MOUNT}/`)) return "console";
  if (path === "/health") return "health";
  if (path === "/metrics") return "metrics";
  return "other";
}

function withAdminNoStore(path: string, response: Response): Response {
  if (isAdminRoute(path)) {
    response.headers.set("cache-control", "no-store");
  }
  return response;
}

function hasRequiredBeta(path: string, betaFeatures: Set<string>): boolean {
  if (betaFeatures.has(MANAGED_AGENTS_BETA)) {
    return true;
  }
  if (path === "/v1/files" || path.startsWith("/v1/files/")) {
    return betaFeatures.has(FILES_API_BETA);
  }
  if (path === "/v1/skills" || path.startsWith("/v1/skills/")) {
    return betaFeatures.has(SKILLS_API_BETA);
  }
  return false;
}

function jsonError(
  body: ApiErrorBody,
  status: number,
  retryAfterSeconds?: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "request-id": body.request_id,
      ...(retryAfterSeconds === undefined
        ? {}
        : { "retry-after": String(retryAfterSeconds) }),
    },
  });
}
