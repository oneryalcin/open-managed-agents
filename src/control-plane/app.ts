import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createAdminAuth, loadAdminKey, type AdminAuth } from "./admin/auth.ts";
import { adminRoutes } from "./admin/routes.ts";
import { DefaultAdminService, type AdminService } from "./admin/service.ts";
import { agentsRoutes } from "./agents/routes.ts";
import { DefaultAgentService } from "./agents/service.ts";
import { SqliteAgentStore } from "./agents/store.ts";
import type { AgentService } from "./agents/types.ts";
import type { ManagedAgentsCustomTool } from "../types/agents.ts";
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
import { createBestEffortSessionOutputCoordinator } from "./deployment-session-output-coordinator.ts";
import { createBestEffortRuntimeEventCoordinator } from "./deployment-runtime-event-coordinator.ts";
import type {
  RuntimeEventRunner,
  RuntimeEventTranslator,
  SessionEventsService,
} from "./events/types.ts";
import type { FileStorage } from "./files/types.ts";
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
import { randomBytes } from "node:crypto";
import {
  hasEgressNetworkingConfig,
  resolveSessionEgressBundle,
} from "./egress/policy.ts";
import type { SecretsStore } from "./secrets/types.ts";
import { DEFAULT_SIDECAR_PORT } from "./sessions/pi/sandbox/docker-egress.ts";
import type { EgressBundleResolver } from "./sessions/pi/sandbox/docker.ts";
import { secretsRoutes } from "./secrets/routes.ts";
import { DefaultSecretsService, type SecretsService } from "./secrets/service.ts";
import { sessionsRoutes } from "./sessions/routes.ts";
import { DefaultSessionService } from "./sessions/service.ts";
import { SqliteSessionStore } from "./sessions/store.ts";
import type {
  SessionFileMountSnapshotRow,
  SessionService,
} from "./sessions/types.ts";
import type { PiSessionFileMountResolver } from "./sessions/pi/runner.ts";
import { createStoreBackedBuiltinToolAccessResolver } from "./sessions/pi/tool-permissions.ts";
import { translatePiEvent } from "./sessions/pi/translator.ts";

export const MAX_REQUEST_BODY_BYTES = 1_048_576;
export const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
export const FILES_API_BETA = "files-api-2025-04-14";

type AppEnv = ControlPlaneRouteEnv;

export interface ControlPlaneAuth {
  authenticate(plaintextKey: string): WorkspaceId | undefined;
}

export interface ControlPlaneServices {
  admin?: {
    service: AdminService;
    auth: AdminAuth;
  };
  agents: AgentService;
  environments: EnvironmentService;
  files?: FileService;
  // Absent = no secrets backend wired; the routes still register and return
  // the clear "requires a master key" 400 (never a confusing 404).
  secrets?: SecretsService;
  sessions: SessionService;
  sessionEvents: SessionEventsService;
  auth?: ControlPlaneAuth;
  admission?: AdmissionLimits;
}

export interface InMemoryControlPlaneAppOptions {
  runtime?: {
    runner: RuntimeEventRunner;
    translate: RuntimeEventTranslator;
  };
}

export interface DeploymentControlPlaneAppOptions {
  runner?: DeploymentPiSessionRunnerOptions;
}

export type DeploymentAuthMode = "api-key" | "disabled";

export interface DeploymentAuthEnv {
  OMA_AUTH_MODE?: string;
  OMA_ADMIN_KEY?: string;
  OMA_ADMIN_KEY_FILE?: string;
}

export type DeploymentControlPlaneEnv =
  DeploymentRuntimeEnv &
  DeploymentStorageEnv &
  DeploymentAuthEnv &
  DeploymentAdmissionEnv;

// 0113 D5: exactly two values; unset stays disabled for the currently allowed
// rollout tiers but warns loudly; anything else fails construction.
export function parseDeploymentAuthMode(
  env: DeploymentAuthEnv,
  opts: { warn?: (message: string) => void } = {},
): DeploymentAuthMode {
  const raw = env.OMA_AUTH_MODE;
  if (raw === undefined) {
    (opts.warn ?? console.warn)(
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
  const app = new Hono<AppEnv>();
  const defaultBodyLimit = bodyLimit({
    maxSize: MAX_REQUEST_BODY_BYTES,
    onError: (c) => {
      const err = requestTooLarge();
      return jsonError(toApiErrorBody(err, c.get("requestId")), err.status);
    },
  });

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
      const key = c.req.header("x-admin-key");
      if (key === undefined || !adminAuth.verify(key)) {
        const err = authenticationFailed();
        return jsonError(toApiErrorBody(err, c.get("requestId")), err.status);
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
    if (c.req.method === "POST" && c.req.path === "/v1/files") {
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
    "/v1/secrets",
    secretsRoutes(services.secrets ?? new DefaultSecretsService(undefined)),
  );
  app.route("/v1/sessions", sessionsRoutes(services.sessions, services.sessionEvents));
  app.route(
    "/v1/sessions/:sessionId/events",
    sessionEventsRoutes(services.sessionEvents, services.admission),
  );
  if (services.admin) {
    app.route("/admin", adminRoutes(services.admin.service));
  }

  app.notFound((c) => {
    const err = new ApiError(404, "not_found_error", "Route not found");
    return jsonError(toApiErrorBody(err, c.get("requestId")), err.status);
  });

  app.onError((error, c) => {
    const err = ensureApiError(error);
    return jsonError(
      toApiErrorBody(err, c.get("requestId")),
      err.status,
      err.retryAfterSeconds,
    );
  });

  return app;
}

export interface DeploymentControlPlane {
  app: Hono<AppEnv>;
  stores: DeploymentStores;
  authMode: DeploymentAuthMode;
}

export function createDeploymentControlPlaneApp(
  env: DeploymentControlPlaneEnv = process.env,
  opts: DeploymentControlPlaneAppOptions = {},
): Hono<AppEnv> {
  return createDeploymentControlPlane(env, opts).app;
}

// Same wiring as createDeploymentControlPlaneApp, but hands back the stores
// so a caller that owns the process lifecycle (the appliance entrypoint,
// tests that boot twice against one OMA_HOME) can close them and release the
// .oma.lock instead of leaking them until process exit.
export function createDeploymentControlPlane(
  env: DeploymentControlPlaneEnv = process.env,
  opts: DeploymentControlPlaneAppOptions = {},
): DeploymentControlPlane {
  const runtimeConfig = parseDeploymentRuntimeConfigFromEnv(env);
  const authMode = parseDeploymentAuthMode(env);
  const admission = createAdmissionLimits(parseAdmissionLimitsFromEnv(env));
  const adminKey = loadAdminKey(env);
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
  const broadcaster = new SessionEventBroadcaster(stores.events);
  const runner = createDeploymentPiSessionRunner(runtimeConfig, {
    ...opts.runner,
    resolveEgressBundle:
      opts.runner?.resolveEgressBundle ??
      createSessionEgressBundleResolver({
        sessions: stores.sessions,
        environments: stores.environments,
        ...(stores.secrets === undefined ? {} : { secrets: stores.secrets }),
      }),
    fileMountResolver: createFileMountResolver(stores.sessions, stores.files),
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
    admission.maxPendingRuntimeTurnsPerWorkspace === undefined
      ? {}
      : {
          maxPendingRuntimeTurnsPerWorkspace:
            admission.maxPendingRuntimeTurnsPerWorkspace,
        },
  );
  sessionEvents.recoverAllAbandonedRuntimeTurns();
  const app = createControlPlaneApp({
    ...(adminKey === undefined
      ? {}
      : {
          admin: {
            service: new DefaultAdminService(stores.workspaces),
            auth: createAdminAuth(adminKey),
          },
        }),
    ...(authMode === "api-key"
      ? { auth: { authenticate: (key: string) => stores.workspaces.authenticate(key) } }
      : {}),
    agents: new DefaultAgentService(stores.agents),
    environments: new DefaultEnvironmentService(stores.environments),
    files: new DefaultFileService(stores.files),
    secrets: new DefaultSecretsService(stores.secrets),
    sessions: new DefaultSessionService(
      stores.sessions,
      stores.agents,
      stores.environments,
      stores.files,
      {
        runtime: runner,
        egressCapability: {
          canHonorNetworking: runtimeConfig.egress !== undefined,
          hasSecretsStore: stores.secrets !== undefined,
        },
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
      },
    ),
    sessionEvents,
    admission,
  });
  return { app, stores, authMode };
}

export function createInMemoryControlPlaneApp(
  opts: InMemoryControlPlaneAppOptions = {},
): Hono<AppEnv> {
  const agentStore = SqliteAgentStore.open(":memory:");
  const environmentStore = SqliteEnvironmentStore.open(":memory:");
  const sessionStore = SqliteSessionStore.open(":memory:");
  const eventStore = EventStore.open(":memory:");
  const fileStorage = new InMemoryFileStorage();
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
  return createControlPlaneApp({
    agents: new DefaultAgentService(agentStore),
    environments: new DefaultEnvironmentService(environmentStore),
    files: new DefaultFileService(fileStorage),
    sessions: new DefaultSessionService(
      sessionStore,
      agentStore,
      environmentStore,
      fileStorage,
      {
        ...(opts.runtime?.runner ? { runtime: opts.runtime.runner } : {}),
        idempotencyLedger: eventStore,
        createSessionRowsWithIdempotency:
          sessionStore.createAndCompleteIdempotency.bind(sessionStore),
      },
    ),
    sessionEvents: new DefaultSessionEventsService(
      eventStore,
      sessionStore,
      broadcaster,
      opts.runtime
        ? { ...opts.runtime, sessionOutputCoordinator, runtimeEventCoordinator }
        : undefined,
    ),
  });
}

/**
 * Per-session egress bundle resolution (plan 0117e-3, Option A): session ->
 * environment -> networking config -> secrets, resolved at sandbox-create
 * time inside the docker factory closure. Returns undefined for a session
 * whose environment grants no egress — including hosted-shape networking
 * (`{type:"unrestricted"}`), which OMA has always ignored. Mints a fresh
 * URL-safe proxy-auth token per session.
 */
export function createSessionEgressBundleResolver(stores: {
  sessions: Pick<SqliteSessionStore, "retrieveAny">;
  environments: Pick<SqliteEnvironmentStore, "retrieve">;
  secrets?: Pick<SecretsStore, "reveal">;
}): EgressBundleResolver {
  return async (workspaceId, sessionId, context) => {
    // Normal prompt-time sandbox creation reads the persisted session row. The
    // file-resource create path prepares its sandbox before that row is
    // committed, so DefaultSessionService passes the already-validated
    // environmentId as a creation-time hint.
    const environmentId = context?.environmentId;
    const session =
      environmentId === undefined
        ? stores.sessions.retrieveAny(workspaceId, sessionId)
        : undefined;
    if (environmentId === undefined && !session) return undefined;
    const resolvedEnvironmentId = environmentId ?? session!.environment_id;
    const environment = stores.environments.retrieve(
      workspaceId,
      resolvedEnvironmentId,
    );
    if (!environment) return undefined;
    if (!hasEgressNetworkingConfig(environment.config)) return undefined;
    const resolved = resolveSessionEgressBundle({
      environmentConfig: environment.config,
      revealSecret: (name) => stores.secrets?.reveal(workspaceId, name),
      listenPort: DEFAULT_SIDECAR_PORT,
      proxyAuthToken: randomBytes(24).toString("hex"),
    });
    if (resolved === undefined) return undefined;
    return { bundle: resolved.bundle, sandboxEnv: resolved.sandboxEnv };
  };
}

function createFileMountResolver(
  sessionStore: Pick<SqliteSessionStore, "getFileMountSnapshots">,
  fileStorage: Pick<FileStorage, "openInternalSnapshotBytes">,
): PiSessionFileMountResolver {
  return async (workspaceId, sessionId) => {
    const snapshots = sessionStore.getFileMountSnapshots(workspaceId, sessionId);
    return Promise.all(
      snapshots.map(async (snapshot) =>
        snapshotToRuntimeMount(workspaceId, fileStorage, snapshot),
      ),
    );
  };
}

async function snapshotToRuntimeMount(
  workspaceId: string,
  fileStorage: Pick<FileStorage, "openInternalSnapshotBytes">,
  snapshot: SessionFileMountSnapshotRow,
) {
  const bytes = await fileStorage.openInternalSnapshotBytes(
    workspaceId,
    snapshot.snapshot_file_id,
  );
  if (!bytes) {
    throw new Error(
      `Session file snapshot ${snapshot.snapshot_file_id} not found`,
    );
  }
  return {
    mountPath: snapshot.mount_path,
    snapshotFileId: snapshot.snapshot_file_id,
    sha256: snapshot.sha256,
    sizeBytes: snapshot.size_bytes,
    bytes,
  };
}

function createStoreBackedCustomToolsProvider(opts: {
  sessions: Pick<SqliteSessionStore, "retrieveAny">;
  agents: Pick<SqliteAgentStore, "retrieveAny">;
}): (
  workspaceId: string,
  sessionId: string,
  context?: { agentId?: string },
) => readonly ManagedAgentsCustomTool[] {
  return (workspaceId, sessionId, context) => {
    const session = opts.sessions.retrieveAny(workspaceId, sessionId);
    const agentId = session?.agent.id ?? context?.agentId;
    if (!agentId) return [];
    const agent = opts.agents.retrieveAny(workspaceId, agentId);
    if (!agent) return [];
    const tools = agent.tools.filter(
      (tool): tool is ManagedAgentsCustomTool => tool.type === "custom",
    );
    return tools;
  };
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
    // Secrets MUST be auth-gated: leaving it off this list would skip the
    // auth middleware and fall back to wrk_default (plan 0117e-2).
    "/v1/secrets",
    "/v1/sessions",
  ].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function isAdminRoute(path: string): boolean {
  return path === "/admin" || path.startsWith("/admin/");
}

function hasRequiredBeta(path: string, betaFeatures: Set<string>): boolean {
  if (betaFeatures.has(MANAGED_AGENTS_BETA)) {
    return true;
  }
  if (path === "/v1/files" || path.startsWith("/v1/files/")) {
    return betaFeatures.has(FILES_API_BETA);
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
