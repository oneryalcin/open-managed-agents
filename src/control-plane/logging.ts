// Structured logging with enforced redaction (plan 0121 C1, threat-model §5).
//
// Every control-plane log line goes through this module. Redaction is
// programmatic, not a review convention: a field denylist replaces
// content-bearing keys, and a secret scrubber runs over every string value
// (not just error messages — a pasted key in a label must not survive).
// The logger must never throw, and must import cleanly in the egress
// sidecar: no dependencies beyond the runtime.
//
// Wire contract: one JSON line per event via console.debug/info/warn/error
// (looked up at emit time so test spies and stream semantics both work):
//   {"ts":"…","level":"…","event":"snake_case_name", ...fields}

export type LogLevel = "debug" | "info" | "warn" | "error" | "audit";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Security audit trail: redacted like everything else, but NEVER dropped
   *  by OMA_LOG_LEVEL — an operator turning down diagnostic noise must not
   *  silently lose the admin audit record (C1 review, Codex-adv HIGH). */
  audit(event: string, fields?: LogFields): void;
}

export interface LoggerConfig {
  level: Exclude<LogLevel, "audit">;
  stacks: boolean;
}

// audit outranks every configurable threshold — always emitted.
const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  audit: 50,
};

// Keys that carry content or credentials by construction (threat-model §5
// R1). Content names match per segment (snake/kebab/camel), so compound
// keys like tool_output or errorMessage are caught, while `context` (which
// merely contains "text") is not. Identifiers pass; anything named like key
// material does not — except digest suffixes (key_sha256 is a reference,
// not a secret; the exception is suffix-anchored so password_hash-style
// names stay denied).
const DENY_CONTENT_SEGMENTS = new Set([
  "message",
  "text",
  "prompt",
  "content",
  "input",
  "output",
  "body",
  "authorization",
]);
const DENY_HEURISTIC = /(key|secret|token|password)/i;
const DENY_DIGEST_EXCEPTION = /(sha256|sha512|digest|fingerprint)$/i;

function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .map((segment) => segment.toLowerCase());
}

function isDeniedKey(key: string): boolean {
  if (keySegments(key).some((segment) => DENY_CONTENT_SEGMENTS.has(segment))) {
    return true;
  }
  return DENY_HEURISTIC.test(key) && !DENY_DIGEST_EXCEPTION.test(key);
}

// Credential header/kv assignments: keep the name, mask the whole value —
// including the scheme+credential form (`Authorization: Bearer <token>`),
// where a bare \S+ would stop at the scheme word and leak the token
// (C1 review, Codex P2 / Opus M1).
const HEADER_ASSIGNMENT =
  /(x-api-key|x-admin-key|proxy-authorization|authorization)(\s*[:=]\s*)(?:(?:Bearer|Basic|Digest)\s+)?\S+/gi;
// Workspace API keys: oma_ + base64url(32 bytes) (workspaces/store.ts).
const OMA_KEY = /oma_[A-Za-z0-9_-]+/g;
// Admin/master keys: base64(32 bytes) = 43 chars + optional pad, standalone.
// STANDARD base64 alphabet only (+/) — base64url (-_) would false-positive on
// prefixed UUIDs (`sesrsc_<uuid>` is exactly 43 base64url chars; found when
// the scrubber ate a resource id), and the only base64url secrets OMA mints
// are oma_-prefixed, caught above. `=` is deliberately absent from the
// lookbehind so `SOME_VAR=<key>` assignments still match; the boundary
// assertions keep hex digests and long identifier runs intact.
const BASE64_32_BYTES =
  /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{43}=?(?![A-Za-z0-9+/=])/g;
// Foreign credential shapes that can transit OMA via provider/tool errors
// and egress-vendor debug strings (C1 review, Opus M3 / Codex-adv). This is
// a floor, not an enumeration of the world: Anthropic/OpenAI-style sk-,
// GitHub gh?_ tokens, JWTs, AWS access key ids.
const FOREIGN_KEY_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];
// Credential-bearing query params in logged URLs (egress debug under
// SRT_DEBUG passes raw request URLs): mask the value, keep the param name.
const QUERY_CREDENTIAL =
  /([?&](?:key|apikey|api_key|token|access_token|secret|password|sig|signature|credential)=)[^&\s"']+/gi;

export function scrubSecrets(text: string): string {
  let out = text
    .replace(HEADER_ASSIGNMENT, (_m, name: string, sep: string) => `${name}${sep}[redacted]`)
    .replace(OMA_KEY, "[redacted]")
    .replace(BASE64_32_BYTES, "[redacted]");
  for (const shape of FOREIGN_KEY_SHAPES) {
    out = out.replace(shape, "[redacted]");
  }
  return out.replace(QUERY_CREDENTIAL, "$1[redacted]");
}

const STRING_CAP = 1024;
const STACK_CAP = 4096;
const MAX_DEPTH = 6;

function cap(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…[truncated]`;
}

function scrubAndCap(text: string, limit = STRING_CAP): string {
  return cap(scrubSecrets(text), limit);
}

function serializeError(error: Error, stacks: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: error.name,
    message: scrubAndCap(error.message),
  };
  if (stacks && typeof error.stack === "string") {
    out.stack = scrubAndCap(error.stack, STACK_CAP);
  }
  // One level of cause — enough to diagnose wrapped errors without
  // reintroducing an unbounded structure (deeper causes are dropped).
  if (error.cause instanceof Error) {
    out.cause = { name: error.cause.name, message: scrubAndCap(error.cause.message) };
  } else if (typeof error.cause === "string") {
    out.cause = scrubAndCap(error.cause);
  }
  return out;
}

function redactValue(
  value: unknown,
  stacks: boolean,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") return scrubAndCap(value);
  if (typeof value === "bigint") return String(value);
  if (value === undefined) return undefined;
  if (value instanceof Error) return serializeError(value, stacks);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return "[unserializable]";
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, stacks, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = isDeniedKey(key)
      ? "[redacted]"
      : redactValue(entry, stacks, depth + 1, seen);
  }
  return out;
}

export function redactFields(fields: LogFields, stacks: boolean): Record<string, unknown> {
  return redactValue(fields, stacks, 0, new WeakSet()) as Record<string, unknown>;
}

// House rule: unknown config values refuse to start, never silently coerce.
// (Moved from app.ts so the one parser serves both; app.ts imports it.)
export function parseBooleanFlag(raw: string | undefined, name: string): boolean {
  if (raw === undefined || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error(
    `Unsupported ${name}: ${JSON.stringify(raw)} (expected "1" or "0")`,
  );
}

export function parseLogConfig(env: {
  OMA_LOG_LEVEL?: string;
  OMA_LOG_STACKS?: string;
}): LoggerConfig {
  const raw = env.OMA_LOG_LEVEL ?? "info";
  if (raw !== "debug" && raw !== "info" && raw !== "warn" && raw !== "error") {
    throw new Error(
      `Unsupported OMA_LOG_LEVEL: ${JSON.stringify(raw)} (expected "debug", "info", "warn", or "error")`,
    );
  }
  return {
    level: raw,
    stacks: parseBooleanFlag(env.OMA_LOG_STACKS, "OMA_LOG_STACKS"),
  };
}

export type LogWriter = (level: LogLevel, line: string) => void;

// 0121 C2: oma_log_events_total feed. Module-level because `log` is a
// module singleton; exactly one deployment assembly sets it per process
// (matching the in-process admission-counter scope). Must not throw —
// defensively wrapped at the call site anyway.
let logEventHook: ((level: LogLevel) => void) | undefined;

export function setLogEventHook(hook: (level: LogLevel) => void): void {
  logEventHook = hook;
}

// Looked up per call, not captured: test spies on console.* must intercept,
// and console keeps the debug/info→stdout, warn/error→stderr split. Audit
// lines ride console.info (stdout) — existing admin_audit consumers grep
// stdout, and the audit distinction lives in the JSON `level` field.
const defaultWriter: LogWriter = (level, line) => {
  console[level === "audit" ? "info" : level](line);
};

export function createLogger(config: LoggerConfig, write: LogWriter = defaultWriter): Logger {
  const threshold = LEVEL_RANK[config.level];
  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    if (LEVEL_RANK[level] < threshold) return;
    try {
      logEventHook?.(level);
    } catch {
      // Telemetry must never fail a log emission.
    }
    try {
      const record: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level,
        event,
      };
      for (const [key, value] of Object.entries(redactFields(fields ?? {}, config.stacks))) {
        if (!(key in record)) record[key] = value;
      }
      write(level, JSON.stringify(record));
    } catch {
      // A logger that throws is worse than the event it was reporting.
      try {
        write(
          level,
          JSON.stringify({ ts: new Date().toISOString(), level, event, logger_error: "emit_failed" }),
        );
      } catch {
        // Writer itself failed; nothing sane left to do.
      }
    }
  };
  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    audit: (event, fields) => emit("audit", event, fields),
  };
}

export const log: Logger = createLogger(parseLogConfig(process.env));
