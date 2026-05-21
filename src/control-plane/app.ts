import { Hono } from "hono";
import { agentsRoutes } from "./agents/routes.ts";
import { DefaultAgentService } from "./agents/service.ts";
import { SqliteAgentStore } from "./agents/store.ts";
import type { AgentService } from "./agents/types.ts";
import {
  ApiError,
  type ApiErrorBody,
  ensureApiError,
  requestId,
  toApiErrorBody,
} from "./errors.ts";

interface AppEnv {
  Variables: {
    requestId: string;
  };
}

export interface ControlPlaneServices {
  agents: AgentService;
}

export function createControlPlaneApp(services: ControlPlaneServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const reqId = requestId();
    c.header("request-id", reqId);
    c.set("requestId", reqId);
    await next();
  });

  app.route("/v1/agents", agentsRoutes(services.agents));

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
  return createControlPlaneApp({
    agents: new DefaultAgentService(agentStore),
  });
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
