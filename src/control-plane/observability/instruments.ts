// The control plane's metric inventory (plan 0121 §3.2). Every label is a
// closed enum — adding a label with tenant cardinality (workspace, session)
// requires a plan amendment; per-tenant breakdowns are Arc D.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { MetricsRegistry, type Counter, type Histogram } from "./metrics.ts";

export const ROUTE_CLASSES = ["v1", "admin", "console", "health", "metrics", "other"] as const;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "other"];
// The statuses OMA actually emits; anything novel buckets to other.
const STATUSES = [
  "200", "201", "204", "301", "304",
  "400", "401", "403", "404", "405", "409", "410", "413", "415", "422", "429",
  "500", "501", "503", "529",
  "other",
];
const TURN_OUTCOMES = ["completed", "interrupted", "abandoned", "other"];
const ADMISSION_LIMITS = ["sessions", "turns", "uploads", "streams", "other"];
const ADMISSION_STATUSES = ["429", "529", "other"];
const SANDBOX_EVENTS = ["created", "disposed", "reaped", "other"];
export const SANDBOX_PROVIDERS = [
  "docker-local", "microsandbox-local", "host-passthrough", "none", "other",
];
const LOG_LEVELS = ["debug", "info", "warn", "error", "audit", "other"];
const MODEL_ADMISSION_REASONS = ["provider_disabled", "model_unavailable", "credentials_missing", "other"];
const MODEL_PROVIDER_LABELS = ["anthropic", "openai", "google", "openrouter", "custom", "other"];
const NAMED_MODEL_PROVIDER_LABELS = new Set(["anthropic", "openai", "google", "openrouter"]);

const HTTP_BUCKETS = [0.005, 0.02, 0.1, 0.5, 2, 10];
// Extends past the 15-min idle TTL so TTL-adjacent turns don't vanish into
// +Inf (plan §9 Opus).
const TURN_BUCKETS = [0.25, 1, 5, 15, 60, 300, 900, 1800, 3600];

export interface ControlPlaneMetrics {
  registry: MetricsRegistry;
  httpRequests: Counter;
  httpDuration: Histogram;
  turnsTotal: Counter;
  turnDuration: Histogram;
  admissionRejections: Counter;
  sandboxes: Counter;
  sandboxProviderErrors: Counter;
  logEvents: Counter;
  mcpToolCalls: Counter;
  mcpConnections: Counter;
  modelAdmissionFailures: Counter;
}

export function createControlPlaneMetrics(): ControlPlaneMetrics {
  const registry = new MetricsRegistry();
  return {
    registry,
    httpRequests: registry.counter(
      "oma_http_requests_total",
      "HTTP requests handled, by route class, method, and status.",
      { route_class: ROUTE_CLASSES, method: METHODS, status: STATUSES },
    ),
    httpDuration: registry.histogram(
      "oma_http_request_duration_seconds",
      "HTTP request duration in seconds.",
      HTTP_BUCKETS,
      { route_class: ROUTE_CLASSES },
    ),
    turnsTotal: registry.counter(
      "oma_runtime_turns_total",
      "Runtime turns closed, by outcome.",
      { outcome: TURN_OUTCOMES },
    ),
    turnDuration: registry.histogram(
      "oma_runtime_turn_duration_seconds",
      "Completed runtime turn duration in seconds (accept to close).",
      TURN_BUCKETS,
    ),
    admissionRejections: registry.counter(
      "oma_admission_rejections_total",
      "Admission-limit rejections, by limit and response status.",
      { limit: ADMISSION_LIMITS, status: ADMISSION_STATUSES },
    ),
    sandboxes: registry.counter(
      "oma_sandboxes_total",
      "Sandbox lifecycle events, by event and provider.",
      { event: SANDBOX_EVENTS, provider: SANDBOX_PROVIDERS },
    ),
    sandboxProviderErrors: registry.counter(
      "oma_sandbox_provider_errors_total",
      "Sandbox provider failures during session materialization.",
      { provider: SANDBOX_PROVIDERS },
    ),
    logEvents: registry.counter(
      "oma_log_events_total",
      "Structured log lines emitted, by level.",
      { level: LOG_LEVELS },
    ),
    mcpToolCalls: registry.counter(
      "oma_mcp_tool_calls_total",
      "MCP tool calls, by outcome (plan 0122).",
      { outcome: MCP_TOOL_CALL_OUTCOMES },
    ),
    mcpConnections: registry.counter(
      "oma_mcp_connections_total",
      "MCP server connection attempts, by outcome (plan 0122).",
      { event: MCP_CONNECTION_EVENTS },
    ),
    modelAdmissionFailures: registry.counter(
      "oma_model_admission_failures_total",
      "Model admission failures, by bounded reason and provider class.",
      { reason: MODEL_ADMISSION_REASONS, provider: MODEL_PROVIDER_LABELS },
    ),
  };
}

export function modelProviderMetricLabel(provider: string): string {
  if (NAMED_MODEL_PROVIDER_LABELS.has(provider)) return provider;
  return provider.length > 0 ? "custom" : "other";
}

const MCP_TOOL_CALL_OUTCOMES = ["ok", "error", "denied", "timeout", "aborted"];
const MCP_CONNECTION_EVENTS = ["connected", "connect_failed", "auth_failed"];

export function registerProcessGauges(registry: MetricsRegistry): void {
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  registry.gauge(
    "oma_process_resident_memory_bytes",
    "Resident set size in bytes.",
    () => process.memoryUsage().rss,
  );
  registry.gauge(
    "oma_process_heap_used_bytes",
    "V8 heap used in bytes.",
    () => process.memoryUsage().heapUsed,
  );
  registry.gauge(
    "oma_process_event_loop_delay_seconds",
    "Mean event-loop delay in seconds since the last scrape.",
    () => {
      const mean = loopDelay.mean / 1e9; // ns → s
      loopDelay.reset();
      return mean;
    },
  );
  registry.gauge(
    "oma_process_uptime_seconds",
    "Process uptime in seconds.",
    () => process.uptime(),
  );
}
