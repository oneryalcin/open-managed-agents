import {
  createControlPlaneApp as createRawControlPlaneApp,
  createDeploymentControlPlaneApp as createRawDeploymentControlPlaneApp,
  createInMemoryControlPlaneApp as createRawInMemoryControlPlaneApp,
  FILES_API_BETA,
  MANAGED_AGENTS_BETA,
  MAX_REQUEST_BODY_BYTES,
  parseBetaFeatures,
  type ControlPlaneServices,
  type DeploymentControlPlaneAppOptions,
  type InMemoryControlPlaneAppOptions,
} from "../app.ts";
import type { DeploymentRuntimeEnv } from "../deployment-runtime-config.ts";

export {
  createRawControlPlaneApp,
  createRawDeploymentControlPlaneApp,
  createRawInMemoryControlPlaneApp,
  FILES_API_BETA,
  MANAGED_AGENTS_BETA,
  MAX_REQUEST_BODY_BYTES,
  parseBetaFeatures,
};

export const MANAGED_AGENTS_BETA_HEADERS = {
  "anthropic-beta": MANAGED_AGENTS_BETA,
};

export function withManagedAgentsBeta(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has("anthropic-beta")) {
    headers.set("anthropic-beta", MANAGED_AGENTS_BETA);
  }
  return { ...init, headers };
}

export function createControlPlaneApp(services: ControlPlaneServices) {
  return withDefaultManagedAgentsBeta(createRawControlPlaneApp(services));
}

export function createDeploymentControlPlaneApp(
  env?: DeploymentRuntimeEnv,
  opts?: DeploymentControlPlaneAppOptions,
) {
  return withDefaultManagedAgentsBeta(
    createRawDeploymentControlPlaneApp(env, opts),
  );
}

export function createInMemoryControlPlaneApp(
  opts?: InMemoryControlPlaneAppOptions,
) {
  return withDefaultManagedAgentsBeta(createRawInMemoryControlPlaneApp(opts));
}

function withDefaultManagedAgentsBeta<
  T extends { request: ReturnType<typeof createRawControlPlaneApp>["request"] },
>(app: T): T {
  const rawRequest = app.request.bind(app);
  app.request = ((input, init, ...rest) =>
    rawRequest(input, withManagedAgentsBeta(init), ...rest)) as T["request"];
  return app;
}
