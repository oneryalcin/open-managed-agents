/**
 * Appliance entrypoint (plan 0115, Arc A slice 1 of the 0114 roadmap).
 *
 * One command boots a durable, authenticated OMA server with sensible
 * defaults; the first boot mints the initial workspace API key and prints it
 * exactly once. Every default is an override, not a requirement:
 *
 *   OMA_HOME               data directory (default ~/.oma)
 *   OMA_SQLITE_PATH        explicit DB path (overrides OMA_HOME derivation)
 *   OMA_FILE_STORAGE_ROOT  explicit object root (ditto)
 *   OMA_AUTH_MODE          default api-key; "disabled" is respected
 *   OMA_PORT               default 4180 (0 = ephemeral, for tests)
 *   OMA_HOST               bind address, default 127.0.0.1
 *
 * Run directly (`node --experimental-transform-types src/main.ts`) or via
 * bin/open-managed-agents.mjs, which adds the Node flags.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import {
  createDeploymentControlPlane,
  type DeploymentControlPlaneEnv,
} from "./control-plane/app.ts";
import { DEFAULT_WORKSPACE_ID } from "./control-plane/workspace.ts";

export const DEFAULT_APPLIANCE_PORT = 4180;

export interface ApplianceEnv extends DeploymentControlPlaneEnv {
  OMA_HOME?: string;
  OMA_PORT?: string;
  OMA_HOST?: string;
}

export interface StartApplianceOptions {
  log?: (line: string) => void;
}

export interface RunningAppliance {
  port: number;
  close(): Promise<void>;
}

// Pure so tests can assert the derivation. OMA_HOME only fills the storage
// pair when neither is set explicitly; setting exactly one of the pair still
// hits the existing "must be set together" error from deployment storage.
export function resolveApplianceEnv(env: ApplianceEnv): ApplianceEnv {
  const resolved: ApplianceEnv = { ...env };
  if (
    resolved.OMA_SQLITE_PATH === undefined &&
    resolved.OMA_FILE_STORAGE_ROOT === undefined
  ) {
    const home = resolved.OMA_HOME ?? join(homedir(), ".oma");
    resolved.OMA_SQLITE_PATH = join(home, "oma.sqlite");
    resolved.OMA_FILE_STORAGE_ROOT = join(home, "files");
  }
  resolved.OMA_AUTH_MODE ??= "api-key";
  return resolved;
}

export function parseAppliancePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_APPLIANCE_PORT;
  const port = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || String(port) !== raw.trim()) {
    throw new Error(`Invalid OMA_PORT: ${JSON.stringify(raw)} (expected an integer 0-65535)`);
  }
  return port;
}

export async function startAppliance(
  env: ApplianceEnv = process.env,
  opts: StartApplianceOptions = {},
): Promise<RunningAppliance> {
  const log = opts.log ?? console.log;
  const resolved = resolveApplianceEnv(env);
  const port = parseAppliancePort(resolved.OMA_PORT);
  const host = resolved.OMA_HOST ?? "127.0.0.1";

  const { app, stores, authMode } = createDeploymentControlPlane(resolved);

  // First boot = no key was ever minted (revoked tombstones count as minted).
  // Minting through the live stores keeps this a single connection and means
  // a crash before listen can't strand a printed-but-unusable key.
  const minted =
    authMode === "api-key" && stores.workspaces.countApiKeys() === 0
      ? stores.workspaces.mintKey(DEFAULT_WORKSPACE_ID, "first-boot")
      : undefined;

  const { server, boundPort } = await new Promise<{
    server: ReturnType<typeof serve>;
    boundPort: number;
  }>((resolvePromise) => {
    const s = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
      resolvePromise({ server: s, boundPort: info.port });
    });
  });

  const baseUrl = `http://${host}:${boundPort}`;
  log(`open-managed-agents listening on ${baseUrl}`);
  log(`  data: ${resolved.OMA_SQLITE_PATH} | files: ${resolved.OMA_FILE_STORAGE_ROOT}`);
  log(`  auth: ${authMode}`);
  if (minted !== undefined) {
    log("");
    log(`First boot: minted the initial API key for ${minted.workspaceId}.`);
    log("It is shown once and stored only as a hash — save it now:");
    log("");
    log(`  x-api-key: ${minted.plaintextKey}`);
    log("");
    log(`Connect any Anthropic SDK client with base URL ${baseUrl} and that x-api-key.`);
    log("Mint more keys/workspaces: npx tsx scripts/oma-workspaces.ts --help");
  }

  return {
    port: boundPort,
    close: async () => {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((err) => (err ? reject(err) : resolvePromise()));
      });
      stores.close();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const appliance = await startAppliance(process.env, {});
  const shutdown = () => {
    void appliance.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
