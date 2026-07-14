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
 * `oma up`, whose CLI launcher adds the Node flags and selects a sandbox.
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

  const plane = createDeploymentControlPlane(resolved);
  const { app, stores, authMode } = plane;

  let server: ReturnType<typeof serve> | undefined;
  try {
    const bound = await new Promise<{
      server: ReturnType<typeof serve>;
      boundPort: number;
    }>((resolvePromise, reject) => {
      const onError = (error: Error) => reject(error);
      const s = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
        s.off("error", onError);
        resolvePromise({ server: s, boundPort: info.port });
      });
      s.on("error", onError);
    });
    server = bound.server;
    const boundPort = bound.boundPort;

    // Mint only after the server has bound. First boot = no key was ever
    // minted (revoked tombstones count as minted), so persisting a key on a
    // boot that then fails to bind (EADDRINUSE) would make every later boot
    // skip minting — an unprinted key locking the operator out. A key that
    // prints but never serves only costs a retry; the reverse costs the
    // quickstart.
    const minted =
      authMode === "api-key" && stores.workspaces.countApiKeys() === 0
        ? stores.workspaces.mintKey(DEFAULT_WORKSPACE_ID, "first-boot")
        : undefined;

    const baseUrl = `http://${host}:${boundPort}`;
    log(`open-managed-agents listening on ${baseUrl}`);
    log(`  console: ${baseUrl}/console/`);
    log(`  api: ${baseUrl}`);
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
      // tsx is a devDependency and absent from the Docker image; the node
      // flag works in both the checkout and the container.
      log("Mint more keys/workspaces: node --experimental-transform-types scripts/oma-workspaces.ts --help");
    }

    return {
      port: boundPort,
      close: async () => {
        await closeServer(bound.server);
        await plane.close();
      },
    };
  } catch (error) {
    // Failed startups must release everything (notably .oma.lock) so the
    // operator's retry is a clean boot, not a lock error.
    if (server !== undefined) {
      await closeServer(server).catch(() => {});
    }
    await plane.close();
    throw error;
  }
}

function closeServer(server: ReturnType<typeof serve>): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    server.close((err) => (err ? reject(err) : resolvePromise()));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const appliance = await startAppliance(process.env, {});
  const shutdown = () => {
    void appliance.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
