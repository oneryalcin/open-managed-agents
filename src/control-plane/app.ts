import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
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
  modelProviderMetricLabel,
  registerProcessGauges,
  type ControlPlaneMetrics,
} from "./observability/instruments.ts";
import {
  CONSOLE_MOUNT,
  registerConsoleRoutes,
  type ConsoleStaticConfig,
} from "./console/static.ts";
import {
  CONSOLE_ADMIN_COOKIE,
  CONSOLE_WORKSPACE_COOKIE,
  createConsoleSessionAuth,
  type ConsoleSessionAuth,
} from "./console/auth.ts";
import type { ConsoleBootstrapService } from "./console/bootstrap.ts";
import {
  registerOpenApiRoutes,
  type OpenApiRoutesConfig,
} from "./openapi/routes.ts";
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
import type { EnvironmentNetworkingDeploymentCapability } from "./egress/presets.ts";
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
  type DeploymentRuntimeConfig,
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
import { parseJsonBody } from "./http.ts";
import { DEFAULT_WORKSPACE_ID, type ControlPlaneRouteEnv, type WorkspaceId } from "./workspace.ts";
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
  createStoreBackedAgentRevisionProvider,
  createStoreBackedCustomToolsProvider,
} from "./wiring.ts";
import { createStoreBackedBuiltinToolAccessResolver } from "./sessions/pi/tool-permissions.ts";
import {
  createStoreBackedMcpCredentialResolver,
  createStoreBackedMcpServersProvider,
  createStoreBackedMcpToolAccessResolver,
} from "./sessions/pi/mcp/bridge.ts";
import { createDefaultMcpRuntime } from "./sessions/pi/mcp/runtime.ts";
import {
  PINNED_PI_MODEL_RUNTIME_VERSION,
  createPiModelCatalog,
  type PiModelCatalog,
} from "./models/catalog.ts";
import { modelCatalogRoutes } from "./models/routes.ts";
import {
  DefaultModelCatalogService,
  type ModelCatalogService,
} from "./models/service.ts";
import {
  parseModelDeploymentConfigFromEnv,
  type ModelDeploymentEnv,
} from "./models/deployment-config.ts";
import { createOmaAuthStorageBackend } from "./models/auth-storage-backend.ts";
import { DEFAULT_MCP_OPERATION_TIMEOUT_MS } from "./sessions/pi/mcp/client.ts";
import { createOauthRefreshTicker } from "./vaults/oauth-refresh-ticker.ts";
import type { WakeLoop } from "./wake-loop.ts";
import { translatePiEvent } from "./sessions/pi/translator.ts";
import {
  FILES_API_BETA,
  MANAGED_AGENTS_BETA,
  SKILLS_API_BETA,
} from "./api-constants.ts";

export { FILES_API_BETA, MANAGED_AGENTS_BETA, SKILLS_API_BETA } from "./api-constants.ts";

export const MAX_REQUEST_BODY_BYTES = 1_048_576;
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
  /** Opaque, server-side sessions used only by the browser console. */
  consoleSessionAuth?: {
    service: ConsoleSessionAuth;
    secureCookies: boolean;
    /** Present only for the loopback onboarding process. */
    bootstrap?: ConsoleBootstrapService;
  };
  /** Absent only in minimal test/library assemblies that do not ship UI assets. */
  openapi?: OpenApiRoutesConfig;
  agents: AgentService;
  environments: EnvironmentService;
  environmentNetworking?: EnvironmentNetworkingDeploymentCapability;
  files?: FileService;
  skills?: SkillsService;
  // Absent = no secrets backend wired; the routes still register and return
  // the clear "requires a master key" 400 (never a confusing 404).
  secrets?: SecretsService;
  vaults?: VaultService;
  mcp?: McpOauthValidationDependencies;
  sessions: SessionService;
  sessionEvents: SessionEventsService;
  models?: ModelCatalogService;
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
  environmentNetworking?: EnvironmentNetworkingDeploymentCapability;
}

export interface DeploymentControlPlaneAppOptions {
  runner?: DeploymentPiSessionRunnerOptions;
  /** Hermetic-test seam; the appliance entrypoint never supplies it. */
  testMcp?: {
    fetch?: McpOauthValidationDependencies["fetch"];
    allowInsecureTokenEndpoint?: (url: URL) => boolean;
  };
  /** Process-local one-shot browser handoff; never enabled by normal `oma up`. */
  consoleBootstrap?: ConsoleBootstrapService;
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
  DeploymentObservabilityEnv &
  ModelDeploymentEnv;

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
      const workspaceCookie = getCookie(c, CONSOLE_WORKSPACE_COOKIE);
      const usedConsoleCookie = key === undefined && workspaceCookie !== undefined;
      const workspaceId = key !== undefined
        ? auth.authenticate(key)
        : workspaceCookie === undefined
          ? undefined
          : services.consoleSessionAuth?.service.authenticateWorkspace(workspaceCookie);
      if (workspaceId === undefined) {
        const err = authenticationFailed();
        return jsonError(toApiErrorBody(err, c.get("requestId")), err.status);
      }
      if (usedConsoleCookie && isUnsafeMethod(c.req.method) && !sameOriginForCookieWrite(c)) {
        return c.text("Forbidden\n", 403);
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
      const adminCookie = getCookie(c, CONSOLE_ADMIN_COOKIE);
      const usedConsoleCookie = key === undefined && adminCookie !== undefined;
      const authenticated = key !== undefined
        ? adminAuth.verify(key)
        : adminCookie === undefined
          ? false
          : services.consoleSessionAuth?.service.authenticateAdmin(adminCookie) === true;
      if (!authenticated) {
        const err = authenticationFailed();
        const response = jsonError(
          toApiErrorBody(err, c.get("requestId")),
          err.status,
        );
        response.headers.set("cache-control", "no-store");
        return response;
      }
      if (usedConsoleCookie && isUnsafeMethod(c.req.method) && !sameOriginForCookieWrite(c)) {
        return withAdminNoStore(c.req.path, c.text("Forbidden\n", 403));
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

  if (services.consoleSessionAuth) {
    registerConsoleSessionRoutes(app, services);
  }

  if (services.openapi) {
    registerOpenApiRoutes(app, services.openapi);
  }

  if (services.models) {
    app.route("/v1/model-catalog", modelCatalogRoutes(services.models));
  }
  app.route("/v1/agents", agentsRoutes(services.agents));
  app.route(
    "/v1/environments",
    environmentsRoutes(services.environments, services.environmentNetworking),
  );
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
    app.get("/", (c) => c.redirect("/console/", 302));
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

function registerConsoleSessionRoutes(
  app: Hono<AppEnv>,
  services: ControlPlaneServices,
): void {
  const consoleAuth = services.consoleSessionAuth!;

  app.get("/console/auth/status", (c) => {
    c.header("cache-control", "no-store");
    const workspaceToken = getCookie(c, CONSOLE_WORKSPACE_COOKIE);
    const adminToken = getCookie(c, CONSOLE_ADMIN_COOKIE);
    const workspaceId = workspaceToken === undefined
      ? undefined
      : consoleAuth.service.authenticateWorkspace(workspaceToken);
    return c.json({
      auth_required: services.auth !== undefined,
      workspace: workspaceId === undefined && services.auth === undefined
        ? consoleWorkspace(DEFAULT_WORKSPACE_ID, consoleAuth.service)
        : workspaceId === undefined
        ? null
        : {
            id: workspaceId,
            name: consoleAuth.service.workspaceName(workspaceId) ?? workspaceId,
          },
      admin: adminToken !== undefined && consoleAuth.service.authenticateAdmin(adminToken),
    });
  });

  app.post("/console/auth/workspace", async (c) => {
    if (!sameOriginForCookieWrite(c) || services.auth === undefined) return c.text("Not found\n", 404);
    const session = consoleAuth.service.createWorkspaceSession(stringField(await parseJsonBody(c.req), "api_key"));
    if (session === undefined) return consoleAuthenticationFailed(c);
    setConsoleCookie(c, CONSOLE_WORKSPACE_COOKIE, session.token, consoleAuth.secureCookies, 30 * 24 * 60 * 60);
    c.header("cache-control", "no-store");
    return c.json({ workspace: consoleWorkspace(session.workspaceId, consoleAuth.service) });
  });

  if (consoleAuth.bootstrap !== undefined) {
    app.post("/console/auth/bootstrap/renew", async (c) => {
      const controlToken = c.req.header("x-oma-onboarding-token");
      if (controlToken === undefined) return consoleAuthenticationFailed(c);
      const nonce = consoleAuth.bootstrap!.issueForControlToken(controlToken);
      if (nonce === undefined) return consoleAuthenticationFailed(c);
      c.header("cache-control", "no-store");
      return c.json({ nonce });
    });

    app.post("/console/auth/bootstrap", async (c) => {
      if (!sameOriginForCookieWrite(c)) return c.text("Forbidden\n", 403);
      const nonce = stringField(await parseJsonBody(c.req), "nonce");
      const workspaceKey = consoleAuth.bootstrap!.consume(nonce);
      if (workspaceKey === undefined) return consoleAuthenticationFailed(c);
      const session = consoleAuth.service.createWorkspaceSession(workspaceKey);
      if (session === undefined) return consoleAuthenticationFailed(c);
      setConsoleCookie(c, CONSOLE_WORKSPACE_COOKIE, session.token, consoleAuth.secureCookies, 30 * 24 * 60 * 60);
      c.header("cache-control", "no-store");
      return c.json({ workspace: consoleWorkspace(session.workspaceId, consoleAuth.service) });
    });
  }

  app.post("/console/auth/admin", async (c) => {
    if (!sameOriginForCookieWrite(c) || services.admin === undefined) return c.text("Not found\n", 404);
    const token = consoleAuth.service.createAdminSession(stringField(await parseJsonBody(c.req), "admin_key"));
    if (token === undefined) return consoleAuthenticationFailed(c);
    setConsoleCookie(c, CONSOLE_ADMIN_COOKIE, token, consoleAuth.secureCookies, 8 * 60 * 60);
    c.header("cache-control", "no-store");
    return c.json({ admin: true });
  });

  app.post("/console/auth/select-workspace", async (c) => {
    if (!sameOriginForCookieWrite(c)) return c.text("Forbidden\n", 403);
    const adminToken = getCookie(c, CONSOLE_ADMIN_COOKIE);
    if (adminToken === undefined) return consoleAuthenticationFailed(c);
    const workspaceId = stringField(await parseJsonBody(c.req), "workspace_id");
    const token = consoleAuth.service.selectWorkspace(adminToken, workspaceId);
    if (token === undefined) return consoleAuthenticationFailed(c);
    setConsoleCookie(c, CONSOLE_WORKSPACE_COOKIE, token, consoleAuth.secureCookies, 30 * 24 * 60 * 60);
    c.header("cache-control", "no-store");
    return c.json({ workspace: consoleWorkspace(workspaceId, consoleAuth.service) });
  });

  app.post("/console/auth/logout", (c) => {
    if (!sameOriginForCookieWrite(c)) return c.text("Forbidden\n", 403);
    const workspaceToken = getCookie(c, CONSOLE_WORKSPACE_COOKIE);
    const adminToken = getCookie(c, CONSOLE_ADMIN_COOKIE);
    if (workspaceToken !== undefined) consoleAuth.service.revokeWorkspaceSession(workspaceToken);
    if (adminToken !== undefined) consoleAuth.service.revokeAdminSession(adminToken);
    deleteConsoleCookie(c, CONSOLE_WORKSPACE_COOKIE, consoleAuth.secureCookies);
    deleteConsoleCookie(c, CONSOLE_ADMIN_COOKIE, consoleAuth.secureCookies);
    c.header("cache-control", "no-store");
    return c.body(null, 204);
  });
}

function consoleWorkspace(workspaceId: WorkspaceId, auth: ConsoleSessionAuth): { id: WorkspaceId; name: string } {
  return { id: workspaceId, name: auth.workspaceName(workspaceId) ?? workspaceId };
}

function stringField(body: unknown, name: string): string {
  if (
    typeof body !== "object" || body === null ||
    typeof (body as Record<string, unknown>)[name] !== "string" ||
    (body as Record<string, string>)[name].trim().length === 0
  ) {
    throw new ApiError(400, "invalid_request_error", `\`${name}\` must be a non-empty string`);
  }
  return (body as Record<string, string>)[name].trim();
}

function consoleAuthenticationFailed(c: Context<AppEnv>): Response {
  c.header("cache-control", "no-store");
  const err = authenticationFailed();
  const response = jsonError(toApiErrorBody(err, c.get("requestId")), err.status);
  response.headers.set("cache-control", "no-store");
  return response;
}

function setConsoleCookie(c: Context<AppEnv>, name: string, token: string, secure: boolean, maxAge: number): void {
  setCookie(c, name, token, { httpOnly: true, maxAge, path: "/", sameSite: "Strict", secure });
}

function deleteConsoleCookie(c: Context<AppEnv>, name: string, secure: boolean): void {
  deleteCookie(c, name, { httpOnly: true, path: "/", sameSite: "Strict", secure });
}

function isUnsafeMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function sameOriginForCookieWrite(c: Context<AppEnv>): boolean {
  const origin = c.req.header("origin");
  if (origin === undefined) return false;
  try {
    return new URL(origin).origin === new URL(c.req.url).origin;
  } catch {
    return false;
  }
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
  if (opts.consoleBootstrap !== undefined && !isLoopbackHost(env.OMA_HOST)) {
    throw new Error("Console bootstrap is available only on a loopback appliance bind");
  }
  if (opts.consoleBootstrap !== undefined && env.OMA_TLS_TERMINATED === "1") {
    throw new Error("Console bootstrap is not available behind TLS termination");
  }
  const runtimeConfig = parseDeploymentRuntimeConfigFromEnv(env);
  const modelConfig = parseModelDeploymentConfigFromEnv(env);
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
  let modelCatalog: PiModelCatalog;
  try {
    modelCatalog = opts.runner?.modelCatalog ?? createPiModelCatalog({
      allowedProviders: modelConfig.allowedProviders,
      defaultModel: modelConfig.defaultModel,
      authBackend: createOmaAuthStorageBackend(modelConfig.authPath),
      authPath: modelConfig.authPath,
      modelsPath: modelConfig.modelsPath,
      allowModelAuthCommands: modelConfig.allowModelAuthCommands,
    });
  } catch (error) {
    stores.close();
    throw error;
  }
  const registeredModels = modelCatalog.list();
  const readyModelCount = registeredModels.filter((model) => modelCatalog.hasConfiguredAuth(model)).length;
  log.info("model_catalog_loaded", {
    piVersion: PINNED_PI_MODEL_RUNTIME_VERSION,
    providers: [...modelCatalog.allowedProviders],
    defaultProvider: modelCatalog.defaultModel.provider,
    defaultModel: modelCatalog.defaultModel.id,
    registeredModelCount: registeredModels.length,
    readyModelCount,
    missingCredentialModelCount: registeredModels.length - readyModelCount,
  });
  for (const detail of modelCatalog.securityReport.warnings) {
    log.warn("model_config_warning", { detail });
  }
  const modelAvailability = {
    resolve(model: { provider: string; id: string }) {
      if (!modelCatalog.allowedProviders.has(model.provider)) {
        metrics?.modelAdmissionFailures.inc({
          reason: "provider_disabled",
          provider: modelProviderMetricLabel(model.provider),
        });
        throw new ApiError(
          400,
          "invalid_request_error",
          `Model provider ${model.provider} is not enabled on this deployment`,
        );
      }
      const resolved = modelCatalog.resolve(model);
      if (!resolved) {
        metrics?.modelAdmissionFailures.inc({
          reason: "model_unavailable",
          provider: modelProviderMetricLabel(model.provider),
        });
        throw new ApiError(
          400,
          "invalid_request_error",
          `Model ${model.provider}/${model.id} is not available on this deployment`,
        );
      }
      return resolved;
    },
    assertAvailable(model: { provider: string; id: string }): void {
      this.resolve(model);
    },
    assertReady(model: { provider: string; id: string }): void {
      const resolved = this.resolve(model);
      if (!modelCatalog.hasConfiguredAuth(resolved)) {
        metrics?.modelAdmissionFailures.inc({
          reason: "credentials_missing",
          provider: modelProviderMetricLabel(model.provider),
        });
        throw new ApiError(
          400,
          "invalid_request_error",
          `Credentials for model provider ${model.provider} are not configured on this deployment`,
        );
      }
    },
  };
  const runner = createDeploymentPiSessionRunner(runtimeConfig, {
    ...opts.runner,
    modelCatalog,
    agentRevision: createStoreBackedAgentRevisionProvider({
      sessions: stores.sessions,
      agents: stores.agents,
    }),
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
  const openapiRoot = bundledOpenApiDocsRoot();
  const adminAuth = adminKey === undefined ? undefined : createAdminAuth(adminKey);
  const consoleSessionAuth = createConsoleSessionAuth({
    workspaces: stores.workspaces,
    ...(adminAuth === undefined ? {} : { admin: adminAuth }),
  });
  const app = createControlPlaneApp({
    ...(adminKey === undefined
      ? {}
      : {
          admin: {
            service: new DefaultAdminService(stores.workspaces, stores.vaults),
            auth: adminAuth!,
          },
        }),
    // Secret-free static content, so it serves whenever the dir shipped —
    // deliberately not coupled to admin being enabled (0120 §3.1): a
    // read-only /v1 browser is useful without an admin key.
    ...(consoleRoot === undefined ? {} : { console: { root: consoleRoot } }),
    consoleSessionAuth: {
      service: consoleSessionAuth,
      secureCookies: tlsTerminated,
      ...(opts.consoleBootstrap === undefined ? {} : { bootstrap: opts.consoleBootstrap }),
    },
    ...(openapiRoot === undefined ? {} : { openapi: { root: openapiRoot } }),
    ...(authMode === "api-key"
      ? {
          auth: {
            authenticate: (key: string) => stores.workspaces.authenticate(key),
          },
        }
      : {}),
    agents: new DefaultAgentService(
      stores.agents,
      stores.skills,
      modelAvailability,
    ),
    environments: new DefaultEnvironmentService(stores.environments, stores.sessions),
    environmentNetworking: environmentNetworkingCapability(runtimeConfig),
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
        modelAvailability,
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
    models: new DefaultModelCatalogService(modelCatalog),
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

function bundledOpenApiDocsRoot(): string | undefined {
  const root = fileURLToPath(new URL("../../ui/openapi-docs", import.meta.url));
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
  const openapiRoot = bundledOpenApiDocsRoot();
  return createControlPlaneApp({
    ...(openapiRoot === undefined ? {} : { openapi: { root: openapiRoot } }),
    agents: new DefaultAgentService(agentStore, skillsStore),
    environments: new DefaultEnvironmentService(environmentStore, sessionStore),
    ...(opts.environmentNetworking === undefined
      ? {}
      : { environmentNetworking: opts.environmentNetworking }),
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

function environmentNetworkingCapability(
  runtimeConfig: DeploymentRuntimeConfig,
): EnvironmentNetworkingDeploymentCapability {
  const provider = runtimeConfig.sandboxProviderSelection?.type ?? null;
  if (runtimeConfig.egress !== undefined) {
    return { provider, egress_supported: true, reason: null };
  }
  const reason = provider === "docker-local"
    ? "Docker-local is configured without the OMA egress sidecar. Restart through `oma up` to use networked presets."
    : provider === null || provider === "none"
      ? "No sandbox provider with egress support is configured."
      : `Environment allowlists are not supported by ${provider}.`;
  return { provider, egress_supported: false, reason };
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
    "/v1/model-catalog",
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
