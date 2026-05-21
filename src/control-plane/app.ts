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
import type { SessionService } from "./sessions/types.ts";

export const MAX_REQUEST_BODY_BYTES = 1_048_576;
export const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";

interface AppEnv {
  Variables: {
    requestId: string;
    betaFeatures: Set<string>;
  };
}

export interface ControlPlaneServices {
  agents: AgentService;
  environments: EnvironmentService;
  sessions: SessionService;
}

export function createControlPlaneApp(services: ControlPlaneServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const reqId = requestId();
    c.header("request-id", reqId);
    c.set("requestId", reqId);
    await next();
  });

  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_REQUEST_BODY_BYTES,
      onError: (c) => {
        const err = requestTooLarge();
        return jsonError(toApiErrorBody(err, c.get("requestId")), err.status);
      },
    }),
  );

  app.use("*", async (c, next) => {
    c.set("betaFeatures", parseBetaFeatures(c.req.header("anthropic-beta")));
    await next();
  });

  app.route("/v1/agents", agentsRoutes(services.agents));
  app.route("/v1/environments", environmentsRoutes(services.environments));
  app.route("/v1/sessions", sessionsRoutes(services.sessions));

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

export function createInMemoryControlPlaneApp(): Hono<AppEnv> {
  const agentStore = SqliteAgentStore.open(":memory:");
  const environmentStore = SqliteEnvironmentStore.open(":memory:");
  const sessionStore = SqliteSessionStore.open(":memory:");
  return createControlPlaneApp({
    agents: new DefaultAgentService(agentStore),
    environments: new DefaultEnvironmentService(environmentStore),
    sessions: new DefaultSessionService(
      sessionStore,
      agentStore,
      environmentStore,
    ),
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

function jsonError(body: ApiErrorBody, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "request-id": body.request_id,
    },
  });
}
