import {
  createControlPlaneApp as createRawControlPlaneApp,
  createDeploymentControlPlaneApp as createRawDeploymentControlPlaneApp,
  createInMemoryControlPlaneApp as createRawInMemoryControlPlaneApp,
  FILES_API_BETA,
  SKILLS_API_BETA,
  MANAGED_AGENTS_BETA,
  MAX_REQUEST_BODY_BYTES,
  parseBetaFeatures,
  type ControlPlaneServices,
  type DeploymentControlPlaneAppOptions,
  type InMemoryControlPlaneAppOptions,
} from "../app.ts";
import type { DeploymentControlPlaneEnv } from "../app.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export {
  createRawControlPlaneApp,
  createRawDeploymentControlPlaneApp,
  createRawInMemoryControlPlaneApp,
  FILES_API_BETA,
  SKILLS_API_BETA,
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
  env?: DeploymentControlPlaneEnv,
  opts?: DeploymentControlPlaneAppOptions,
) {
  return withDefaultManagedAgentsBeta(
    createRawDeploymentControlPlaneApp(withTestModelHome(env), opts),
  );
}

export function withTestModelHome(
  env: DeploymentControlPlaneEnv = {},
): DeploymentControlPlaneEnv {
  return {
    ...env,
    OMA_HOME: env.OMA_HOME ?? mkdtempSync(join(tmpdir(), "oma-test-home-")),
  };
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
