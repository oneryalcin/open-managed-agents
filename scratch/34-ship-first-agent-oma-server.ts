/**
 * Local OMA HTTP server for Probe 34.
 *
 * Run:
 *   OMA_SANDBOX_PROVIDER=docker-local \
 *   OMA_ALLOW_DOCKER_LOCAL=true \
 *   ANTHROPIC_API_KEY=... \
 *   OMA_PROBE_PORT=40178 \
 *   npx tsx scratch/34-ship-first-agent-oma-server.ts
 */

import { serve } from "@hono/node-server";
import { createDeploymentControlPlaneApp } from "../src/control-plane/app.ts";

const port = Number.parseInt(process.env.OMA_PROBE_PORT ?? "40178", 10);
if (!Number.isSafeInteger(port) || port <= 0) {
  throw new Error(`invalid OMA_PROBE_PORT: ${process.env.OMA_PROBE_PORT}`);
}

const app = createDeploymentControlPlaneApp({
  ...process.env,
  OMA_SANDBOX_PROVIDER: process.env.OMA_SANDBOX_PROVIDER ?? "docker-local",
  OMA_ALLOW_DOCKER_LOCAL: process.env.OMA_ALLOW_DOCKER_LOCAL ?? "true",
});

const server = serve({ fetch: app.fetch, port });
console.log(JSON.stringify({ ready: true, port, base_url: `http://127.0.0.1:${port}` }));

const shutdown = () => {
  server.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
