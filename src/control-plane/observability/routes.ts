// /health + /metrics (plan 0121 §3.1–3.2).
//
// /health is deliberately unauthenticated (LB and compose probes can't send
// keys; the body carries no tenant data). /metrics is FAIL-CLOSED: the
// deployment assembly resolves the exposure mode from the configured bind
// host — never from request headers or socket data — and this module only
// ever sees the resolved decision.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statfsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import type { Env } from "hono";
import { EXPOSITION_CONTENT_TYPE, type MetricsRegistry } from "./metrics.ts";

export interface HealthCheckResult {
  status: "ok" | "failed";
  [detail: string]: unknown;
}

export interface ObservabilityRoutesConfig {
  health: {
    /** Cheap probes; a throw counts as failed. */
    storage: () => HealthCheckResult;
    runtime: () => HealthCheckResult;
  };
  /** Absent = /metrics stays unregistered (fail-closed 404). */
  metrics?: {
    registry: MetricsRegistry;
    /** Set = Authorization: Bearer required (constant-time compare). */
    tokenSha256?: Buffer;
  };
}

export const METRICS_TOKEN_ENV = "OMA_METRICS_TOKEN";
export const METRICS_TOKEN_FILE_ENV = "OMA_METRICS_TOKEN_FILE";

export interface MetricsTokenEnv {
  OMA_METRICS_TOKEN?: string;
  OMA_METRICS_TOKEN_FILE?: string;
}

export function loadMetricsToken(env: MetricsTokenEnv): string | undefined {
  const direct = env[METRICS_TOKEN_ENV];
  const file = env[METRICS_TOKEN_FILE_ENV];
  if (direct !== undefined && file !== undefined) {
    throw new Error(
      `set exactly one of ${METRICS_TOKEN_ENV} or ${METRICS_TOKEN_FILE_ENV}, not both`,
    );
  }
  if (direct === undefined && file === undefined) return undefined;
  const value =
    direct === undefined ? readFileSync(file!, "utf8").trim() : direct.trim();
  if (value.length === 0) {
    throw new Error(
      `${direct === undefined ? METRICS_TOKEN_FILE_ENV : METRICS_TOKEN_ENV} must not be empty`,
    );
  }
  return value;
}

export function sha256Token(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

// package.json is app-root-relative so the same derivation works from a
// checkout and inside the image (same pattern as bundledConsoleRoot).
export function packageVersion(): string {
  try {
    const raw = readFileSync(
      fileURLToPath(new URL("../../../package.json", import.meta.url)),
      "utf8",
    );
    return String((JSON.parse(raw) as { version?: string }).version ?? "unknown");
  } catch {
    return "unknown";
  }
}

// Reported, never gating: a disk-threshold 503 would flap the single node
// and drive compose restart loops — alert on it instead (plan §3.1).
export function storageFreeBytes(root: string): number | undefined {
  try {
    const stat = statfsSync(root);
    return stat.bavail * stat.bsize;
  } catch {
    return undefined;
  }
}

export function registerObservabilityRoutes<E extends Env>(
  app: Hono<E>,
  config: ObservabilityRoutesConfig,
): void {
  const version = packageVersion();

  app.get("/health", (c) => {
    const storage = runCheck(config.health.storage);
    const runtime = runCheck(config.health.runtime);
    const ok = storage.status === "ok" && runtime.status === "ok";
    c.header("cache-control", "no-store");
    return c.json(
      {
        status: ok ? "ok" : "degraded",
        version,
        uptime_seconds: Math.round(process.uptime()),
        checks: { storage, runtime },
      },
      ok ? 200 : 503,
    );
  });

  const metrics = config.metrics;
  if (metrics === undefined) return;

  app.get("/metrics", (c) => {
    if (metrics.tokenSha256 !== undefined) {
      const authorization = c.req.header("authorization");
      const presented = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
      if (
        presented === undefined ||
        !timingSafeEqual(sha256Token(presented), metrics.tokenSha256)
      ) {
        // No body detail: an unauthenticated caller learns nothing about
        // the endpoint beyond its existence.
        return c.body(null, 401, { "cache-control": "no-store" });
      }
    }
    return c.body(metrics.registry.exposition(), 200, {
      "content-type": EXPOSITION_CONTENT_TYPE,
      "cache-control": "no-store",
    });
  });
}

function runCheck(check: () => HealthCheckResult): HealthCheckResult {
  try {
    return check();
  } catch {
    // Coarse on purpose: no stacks, no paths on an unauthenticated endpoint.
    return { status: "failed" };
  }
}
