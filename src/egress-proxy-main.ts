/**
 * Per-session egress proxy sidecar entrypoint (plan 0117d; ADR 0016 §2/§3).
 *
 * The vendored `createEgressProxy` runs OUT of the long-lived control-plane
 * process, in its own short-lived container, so the control plane never joins
 * the sandbox's network (the sandbox's sole route out is this proxy). It is
 * launched with the SAME appliance image, only a different CMD — no second
 * image to ship.
 *
 * Contract (all via env, since the sidecar takes no CLI args):
 *   OMA_EGRESS_BUNDLE_PATH   read-only mount of the serialized SessionEgressBundle
 *                            (policy + grants + resolved secrets + auth token).
 *                            Holds real secret material — mounted ONLY here.
 *   OMA_EGRESS_SHARED_DIR    a dir shared with the control plane. The sidecar
 *                            writes `ca.crt` (its ephemeral MITM CA cert) and,
 *                            once listening, a `ready` marker. The CA PRIVATE
 *                            KEY never leaves this container.
 *   OMA_EGRESS_BIND_HOST     listen address (default 0.0.0.0 — the sidecar is
 *                            only reachable on the per-session --internal net).
 *
 * The proxy inherits the default SSRF/private-IP deny (we never set the
 * dangerous test flag) and never sets mutateHeadersPlaintext, so secrets are
 * injected only on the TLS-terminated leg.
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import {
  createEgressProxy,
  createMitmCA,
  disposeMitmCA,
  type MitmCA,
} from "./control-plane/egress/proxy.ts";
import {
  buildHooksFromBundle,
  type SessionEgressBundle,
} from "./control-plane/egress/policy.ts";

export interface EgressProxySidecarEnv {
  OMA_EGRESS_BUNDLE_PATH?: string;
  OMA_EGRESS_SHARED_DIR?: string;
  OMA_EGRESS_BIND_HOST?: string;
}

export interface RunningEgressProxySidecar {
  server: Server;
  port: number;
  ca: MitmCA;
  stop: () => Promise<void>;
}

function requiredEnv(env: EgressProxySidecarEnv, key: keyof EgressProxySidecarEnv): string {
  const value = env[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`egress proxy sidecar requires ${key}`);
  }
  return value;
}

export function loadSessionEgressBundle(path: string): SessionEgressBundle {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as SessionEgressBundle;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.listenPort !== "number" ||
    typeof parsed.proxyAuthToken !== "string" ||
    !Array.isArray(parsed.grants) ||
    typeof parsed.policy !== "object"
  ) {
    throw new Error(`egress bundle at ${path} is malformed`);
  }
  return parsed;
}

/**
 * Start the sidecar proxy. Generates the MITM CA in-process, publishes its
 * cert (not its key) to the shared dir, listens, then drops the `ready`
 * marker the control plane waits on before it launches the sandbox.
 */
export async function startEgressProxySidecar(
  env: EgressProxySidecarEnv,
): Promise<RunningEgressProxySidecar> {
  const bundlePath = requiredEnv(env, "OMA_EGRESS_BUNDLE_PATH");
  const sharedDir = requiredEnv(env, "OMA_EGRESS_SHARED_DIR");
  const bindHost = env.OMA_EGRESS_BIND_HOST ?? "0.0.0.0";
  const bundle = loadSessionEgressBundle(bundlePath);

  // Ephemeral CA minted here; only the trust BUNDLE is published (never the
  // key, which could forge certs for any host — it stays in this container).
  // The bundle is the MITM CA followed by the host's public roots: the sandbox
  // trust env vars (SSL_CERT_FILE, CURL_CA_BUNDLE, ...) REPLACE the client's
  // store, so publishing the CA alone would break verification for any host we
  // do NOT terminate (opaque-tunnel / cert-pinned upstreams talk to the real
  // upstream cert). trustBundlePath already contains CA + roots.
  const ca = createMitmCA({});
  copyFileSync(ca.trustBundlePath, join(sharedDir, "ca.crt"));

  const server = createEgressProxy({
    ...buildHooksFromBundle(bundle),
    mitmCA: ca,
    proxyAuthToken: bundle.proxyAuthToken,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(bundle.listenPort, bindHost, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  // Marker is written LAST: its presence means the proxy is accepting
  // connections, so the control plane can start the sandbox without a race.
  writeFileSync(join(sharedDir, "ready"), "", { mode: 0o644 });

  const stop = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disposeMitmCA(ca);
  };
  return { server, port: bundle.listenPort, ca, stop };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startEgressProxySidecar(process.env)
    .then((running) => {
      const shutdown = (): void => {
        void running.stop().then(() => process.exit(0));
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    })
    .catch((error: unknown) => {
      console.error(`egress proxy sidecar failed: ${String(error)}`);
      process.exit(1);
    });
}
