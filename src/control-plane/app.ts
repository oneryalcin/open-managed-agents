import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
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
  ApiError,
  type ApiErrorBody,
  ensureApiError,
  requestTooLarge,
  requestId,
  toApiErrorBody,
} from "./errors.ts";
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

interface AppEnv {
  Variables: {
    requestId: string;
  };
}

export interface ControlPlaneServices {
  agents: AgentService;
  environments: EnvironmentService;
  files?: FileService;
  sessions: SessionService;
  sessionEvents: SessionEventsService;
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

  app.use("*", async (c, next) => {
    const betaFeatures = parseBetaFeatures(c.req.header("anthropic-beta"));
    if (
      isManagedAgentsRoute(c.req.path) &&
      !betaFeatures.has(MANAGED_AGENTS_BETA)
    ) {
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
    filesRoutes(services.files ?? new DefaultFileService(new InMemoryFileStorage())),
  );
  app.route("/v1/sessions", sessionsRoutes(services.sessions, services.sessionEvents));
  app.route("/v1/sessions/:sessionId/events", sessionEventsRoutes(services.sessionEvents));

  app.notFound((c) => {
    const err = new ApiError(404, "not_found_error", "Route not found");
    return jsonError(toApiErrorBody(err, c.get("requestId")), err.status);
  });

  app.onError((error, c) => {
    const err = ensureApiError(error);
    return jsonError(toApiErrorBody(err, c.get("requestId")), err.status);
  });

  return app;
}

export function createDeploymentControlPlaneApp(
  env: DeploymentRuntimeEnv = process.env,
  opts: DeploymentControlPlaneAppOptions = {},
): Hono<AppEnv> {
  const runtimeConfig = parseDeploymentRuntimeConfigFromEnv(env);
  const agentStore = SqliteAgentStore.open(":memory:");
  const environmentStore = SqliteEnvironmentStore.open(":memory:");
  const sessionStore = SqliteSessionStore.open(":memory:");
  const eventStore = EventStore.open(":memory:");
  const fileStorage = new InMemoryFileStorage();
  const broadcaster = new SessionEventBroadcaster(eventStore);
  const runner = createDeploymentPiSessionRunner(runtimeConfig, {
    ...opts.runner,
    fileMountResolver: createFileMountResolver(sessionStore, fileStorage),
    builtinToolAccess: createStoreBackedBuiltinToolAccessResolver({
      sessions: sessionStore,
      agents: agentStore,
    }),
  });
  const runtime = { runner, translate: translatePiEvent };
  const sessionEvents = new DefaultSessionEventsService(
    eventStore,
    sessionStore,
    broadcaster,
    runtime,
  );
  sessionEvents.recoverAbandonedRuntimeTurns("wrk_default");
  return createControlPlaneApp({
    agents: new DefaultAgentService(agentStore),
    environments: new DefaultEnvironmentService(environmentStore),
    files: new DefaultFileService(fileStorage),
    sessions: new DefaultSessionService(
      sessionStore,
      agentStore,
      environmentStore,
      fileStorage,
      { runtime: runner },
    ),
    sessionEvents,
  });
}

export function createInMemoryControlPlaneApp(
  opts: InMemoryControlPlaneAppOptions = {},
): Hono<AppEnv> {
  const agentStore = SqliteAgentStore.open(":memory:");
  const environmentStore = SqliteEnvironmentStore.open(":memory:");
  const sessionStore = SqliteSessionStore.open(":memory:");
  const eventStore = EventStore.open(":memory:");
  const fileStorage = new InMemoryFileStorage();
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
      opts.runtime?.runner ? { runtime: opts.runtime.runner } : {},
    ),
    sessionEvents: new DefaultSessionEventsService(
      eventStore,
      sessionStore,
      broadcaster,
      opts.runtime,
    ),
  });
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
    "/v1/sessions",
  ].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function jsonError(body: ApiErrorBody, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "request-id": body.request_id,
    },
  });
}
