// Plan 0121 C1: the logger is the redaction chokepoint (threat-model §5).
// These tests assert planted secrets are ABSENT from output — not merely
// truncated (a cap-only test would bless the leak, plan §9).
import { describe, expect, it, vi, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLogger,
  log,
  parseLogConfig,
  scrubKnownSecrets,
  scrubSecrets,
  type LogLevel,
} from "../logging.ts";
import { createDeploymentControlPlane } from "../app.ts";

function captureLogger(config?: {
  level?: Exclude<LogLevel, "audit">;
  stacks?: boolean;
}) {
  const lines: Array<{ level: LogLevel; line: string }> = [];
  const logger = createLogger(
    { level: config?.level ?? "info", stacks: config?.stacks ?? false },
    (level, line) => lines.push({ level, line }),
  );
  return { logger, lines };
}

const WORKSPACE_KEY = `oma_${randomBytes(32).toString("base64url")}`;
const ADMIN_SHAPED_KEY = randomBytes(32).toString("base64");
const modelHomes: string[] = [];

function tempModelHome(): string {
  const root = mkdtempSync(join(tmpdir(), "oma-logging-models-"));
  modelHomes.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of modelHomes.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("logger output shape", () => {
  it("emits one JSON line with ts/level/event plus fields", () => {
    const { logger, lines } = captureLogger();
    logger.info("thing_happened", { sessionId: "ses_1", attempt: 2 });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0].line);
    expect(record).toMatchObject({
      level: "info",
      event: "thing_happened",
      sessionId: "ses_1",
      attempt: 2,
    });
    expect(new Date(record.ts).toISOString()).toBe(record.ts);
  });

  it("reserved keys win over field collisions", () => {
    const { logger, lines } = captureLogger();
    logger.info("real_event", { event: "spoofed", level: "error" });
    const record = JSON.parse(lines[0].line);
    expect(record.event).toBe("real_event");
    expect(record.level).toBe("info");
  });

  it("filters below the configured level", () => {
    const { logger, lines } = captureLogger({ level: "warn" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(lines.map((entry) => entry.level)).toEqual(["warn", "error"]);
  });

  it("suppresses debug at the default info level", () => {
    const { logger, lines } = captureLogger();
    logger.debug("noisy_internal_detail");
    expect(lines).toHaveLength(0);
  });

  it("survives circular fields without throwing", () => {
    const { logger, lines } = captureLogger();
    const loop: Record<string, unknown> = { sessionId: "ses_1" };
    loop.self = loop;
    logger.info("looped", { loop });
    expect(lines[0].line).toContain("[circular]");
  });

  it("emits a fallback line when field serialization itself throws", () => {
    const { logger, lines } = captureLogger();
    const hostile = {};
    Object.defineProperty(hostile, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });
    logger.error("hostile_fields", { hostile });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0].line)).toMatchObject({
      event: "hostile_fields",
      logger_error: "emit_failed",
    });
  });

  it("audit level bypasses the configured threshold", () => {
    const { logger, lines } = captureLogger({ level: "error" });
    logger.info("diagnostic_noise");
    logger.audit("admin_audit", { action: "mint_key" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0].line)).toMatchObject({
      level: "audit",
      event: "admin_audit",
      action: "mint_key",
    });
  });
});

describe("scrubKnownSecrets (exact-value, plan 0122 §7B.9 slice 0)", () => {
  it("replaces every occurrence of each known value", () => {
    expect(
      scrubKnownSecrets("a vault-token-echo b vault-token-echo", ["vault-token-echo"]),
    ).toBe("a [redacted] b [redacted]");
  });

  it("scrubs the containing value intact when values nest (header vs bare token)", () => {
    const out = scrubKnownSecrets("hdr=Bearer tok-12345678; raw=tok-12345678", [
      "tok-12345678",
      "Bearer tok-12345678",
    ]);
    expect(out).toBe("hdr=[redacted]; raw=[redacted]");
  });

  it("scrubs common whole-value encodings of known secrets", () => {
    const secret = "access+/0=&?%_CANARY";
    const encoded = [
      encodeURIComponent(secret),
      JSON.stringify(secret).slice(1, -1),
      Buffer.from(secret).toString("base64"),
    ];
    expect(scrubKnownSecrets(encoded.join(" "), [secret])).toBe(
      "[redacted] [redacted] [redacted]",
    );
  });

  it("ignores values under 8 chars so a pathological secret cannot shred output", () => {
    expect(scrubKnownSecrets("abc abc abc", ["abc", ""])).toBe("abc abc abc");
  });

  it("is a no-op with no values", () => {
    expect(scrubKnownSecrets("untouched", [])).toBe("untouched");
  });
});

describe("secret scrubbing (absence-based)", () => {
  it("removes oma_ workspace keys from error messages", () => {
    const { logger, lines } = captureLogger();
    logger.error("provider_failed", {
      error: new Error(`provider rejected credential ${WORKSPACE_KEY} for session`),
    });
    expect(lines[0].line).not.toContain(WORKSPACE_KEY);
    expect(lines[0].line).toContain("[redacted]");
  });

  it("removes 32-byte-base64-shaped keys from error messages", () => {
    const { logger, lines } = captureLogger();
    logger.error("config_failed", {
      error: new Error(`invalid master key ${ADMIN_SHAPED_KEY} supplied`),
    });
    expect(lines[0].line).not.toContain(ADMIN_SHAPED_KEY);
  });

  it("masks credential header assignments", () => {
    const { logger, lines } = captureLogger();
    logger.warn("upstream_rejected", {
      error: new Error(`x-admin-key: ${ADMIN_SHAPED_KEY}`),
    });
    expect(lines[0].line).not.toContain(ADMIN_SHAPED_KEY);
    expect(lines[0].line).toContain("x-admin-key");
  });

  it("masks the credential after an Authorization scheme word", () => {
    // A foreign token shape no other pattern matches — only whole-value
    // header masking can catch it (a bare \S+ stops at "Bearer").
    expect(scrubSecrets("Authorization: Bearer hunter2foreigntoken")).not.toContain(
      "hunter2foreigntoken",
    );
    expect(scrubSecrets("proxy-authorization: Basic YWRtaW46cGFzcw")).not.toContain(
      "YWRtaW46cGFzcw",
    );
  });

  it("masks JSON-serialized authorization headers", () => {
    const token = "jsonserializedbearer";
    const scrubbed = scrubSecrets(JSON.stringify({ authorization: `Bearer ${token}` }));
    expect(scrubbed).not.toContain(token);
    expect(scrubbed).toContain('"authorization":"[redacted]"');
  });

  it("scrubs foreign provider key shapes", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1rwW1gFWFOEjXk";
    for (const secret of [
      "sk-ant-api03-abc123def456ghi",
      "ghp_abcdefghij1234567890KLMNOP",
      jwt,
      "AKIAIOSFODNN7EXAMPLE",
    ]) {
      expect(scrubSecrets(`provider rejected ${secret} here`)).not.toContain(secret);
    }
  });

  it("masks credential-bearing query params but keeps the URL readable", () => {
    const out = scrubSecrets(
      "GET https://files.example/download?page=2&token=supersecret9&sig=abc123def 404",
    );
    expect(out).not.toContain("supersecret9");
    expect(out).not.toContain("abc123def");
    expect(out).toContain("https://files.example/download?page=2");
  });

  it("scrubs secrets located beyond the 1 KB cap boundary", () => {
    // Kills the cap-before-scrub mutant: if capping ran first, the secret
    // straddling the boundary would be cut to a fragment that no longer
    // matches the 43-char base64 pattern and would survive. (Deliberately
    // a base64-shaped key, not oma_-prefixed — a truncated oma_ fragment
    // still matches the prefix pattern, which would mask the mutant.)
    const message = "x".repeat(1010) + ` ${ADMIN_SHAPED_KEY}`;
    const { logger, lines } = captureLogger();
    logger.error("late_secret", { error: new Error(message) });
    expect(lines[0].line).not.toContain(ADMIN_SHAPED_KEY.slice(0, 10));
  });

  it("scrubs plain string field values, not just error messages", () => {
    const { logger, lines } = captureLogger();
    logger.info("label_recorded", { label: `pasted ${WORKSPACE_KEY}` });
    expect(lines[0].line).not.toContain(WORKSPACE_KEY);
  });

  it("scrubs non-Error values under the error key", () => {
    const { logger, lines } = captureLogger();
    logger.error("odd_rejection", { error: `string rejection with ${WORKSPACE_KEY}` });
    expect(lines[0].line).not.toContain(WORKSPACE_KEY);
  });

  it("leaves identifiers and hex digests intact", () => {
    const digest = randomBytes(32).toString("hex");
    expect(scrubSecrets(`sha256 mismatch for ${digest} in ses_0198c1c2`)).toBe(
      `sha256 mismatch for ${digest} in ses_0198c1c2`,
    );
  });

  it("leaves prefixed UUID identifiers intact (43-char base64url collision)", () => {
    // sesrsc_<uuid> is exactly 43 chars in the base64url alphabet; the
    // scrubber ate one during C1 until the bare-key pattern was narrowed
    // to standard base64.
    const resourceId = "sesrsc_019f37a2-d8a4-70b3-aa82-df7ee265bb3b";
    expect(scrubSecrets(`cleanup failed for ${resourceId}`)).toBe(
      `cleanup failed for ${resourceId}`,
    );
  });

  it("scrubs env-var-style key assignments", () => {
    expect(scrubSecrets(`OMA_MASTER_KEY=${ADMIN_SHAPED_KEY} rejected`)).not.toContain(
      ADMIN_SHAPED_KEY,
    );
  });
});

describe("field denylist", () => {
  it("redacts content-bearing keys", () => {
    const { logger, lines } = captureLogger();
    logger.warn("tool_failed", {
      prompt: "the user's private prompt text",
      sessionId: "ses_1",
    });
    expect(lines[0].line).not.toContain("private prompt text");
    expect(lines[0].line).toContain('"prompt":"[redacted]"');
    expect(lines[0].line).toContain('"sessionId":"ses_1"');
  });

  it("redacts key-material heuristic matches but passes digests", () => {
    const { logger, lines } = captureLogger();
    // Value deliberately matches NO scrubber pattern — only the key-name
    // denylist can catch it (a scrubber-shaped value would mask a broken
    // denylist, the exact mutant that survived during C1).
    logger.info("audit", { apiKey: "hunter2", key_sha256: "abc123" });
    const record = JSON.parse(lines[0].line);
    expect(record.apiKey).toBe("[redacted]");
    expect(record.key_sha256).toBe("abc123");
  });

  it("redacts denylisted keys in nested objects", () => {
    const { logger, lines } = captureLogger();
    logger.warn("nested", { context: { output: "verbatim tool output" } });
    expect(lines[0].line).not.toContain("verbatim tool output");
  });

  it("redacts compound content keys across naming styles", () => {
    const { logger, lines } = captureLogger();
    logger.warn("compound", {
      tool_output: "verbatim output A",
      errorMessage: "verbatim message B",
      systemPrompt: "verbatim prompt C",
      request_body: "verbatim body D",
    });
    for (const planted of ["verbatim output A", "verbatim message B", "verbatim prompt C", "verbatim body D"]) {
      expect(lines[0].line).not.toContain(planted);
    }
  });

  it("does not redact keys that merely contain a denied word as a substring", () => {
    const { logger, lines } = captureLogger();
    // "context" contains "text"; segment matching must not deny it.
    logger.info("segments", { context: "run 42", latexMode: true });
    const record = JSON.parse(lines[0].line);
    expect(record.context).toBe("run 42");
    expect(record.latexMode).toBe(true);
  });

  it("digest exception is suffix-anchored", () => {
    const { logger, lines } = captureLogger();
    logger.info("digests", {
      key_sha256: "abc123",
      password_hash: "not-actually-safe",
    });
    const record = JSON.parse(lines[0].line);
    expect(record.key_sha256).toBe("abc123");
    expect(record.password_hash).toBe("[redacted]");
  });
});

describe("error serialization", () => {
  it("caps oversized messages", () => {
    const { logger, lines } = captureLogger();
    logger.error("huge_failure", { error: new Error("x".repeat(5000)) });
    const record = JSON.parse(lines[0].line);
    expect(record.error.message.length).toBeLessThan(1100);
    expect(record.error.message).toContain("[truncated]");
  });

  it("omits stacks by default", () => {
    const { logger, lines } = captureLogger();
    logger.error("failed", { error: new Error("boom") });
    expect(JSON.parse(lines[0].line).error).toEqual({ name: "Error", message: "boom" });
  });

  it("includes scrubbed stacks when configured", () => {
    const { logger, lines } = captureLogger({ stacks: true });
    logger.error("failed", { error: new Error(`boom ${WORKSPACE_KEY}`) });
    const record = JSON.parse(lines[0].line);
    expect(record.error.stack).toContain("Error");
    expect(lines[0].line).not.toContain(WORKSPACE_KEY);
  });

  it("serializes one level of scrubbed error cause", () => {
    const { logger, lines } = captureLogger();
    logger.error("wrapped", {
      error: new Error("outer failed", {
        cause: new Error(`inner rejected ${WORKSPACE_KEY}`),
      }),
    });
    const record = JSON.parse(lines[0].line);
    expect(record.error.cause.name).toBe("Error");
    expect(record.error.cause.message).toContain("inner rejected");
    expect(lines[0].line).not.toContain(WORKSPACE_KEY);
  });
});

describe("parseLogConfig", () => {
  it("defaults to info with no stacks", () => {
    expect(parseLogConfig({})).toEqual({ level: "info", stacks: false });
  });

  it("accepts explicit level and stacks flag", () => {
    expect(parseLogConfig({ OMA_LOG_LEVEL: "debug", OMA_LOG_STACKS: "1" })).toEqual({
      level: "debug",
      stacks: true,
    });
  });

  it("refuses unknown OMA_LOG_LEVEL", () => {
    expect(() => parseLogConfig({ OMA_LOG_LEVEL: "verbose" })).toThrow(
      /Unsupported OMA_LOG_LEVEL/,
    );
  });

  it("refuses unknown OMA_LOG_STACKS", () => {
    expect(() => parseLogConfig({ OMA_LOG_STACKS: "yes" })).toThrow(
      /Unsupported OMA_LOG_STACKS/,
    );
  });
});

describe("default writer", () => {
  it("routes through console so test spies and stream semantics hold", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    log.warn("spy_check", { sessionId: "ses_1" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"spy_check"'));
  });
});

describe("request_failed on 5xx", () => {
  it("logs event with requestId matching the response header, secrets absent", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {}); // auth_mode_disabled boot warning
    const plane = createDeploymentControlPlane({ OMA_HOME: tempModelHome() });
    plane.app.get("/test-boom", () => {
      throw new Error(`downstream refused key ${WORKSPACE_KEY}`);
    });
    const res = await plane.app.request("/test-boom");
    expect(res.status).toBe(500);
    const requestId = res.headers.get("request-id");
    expect(requestId).toBeTruthy();
    const line = errorSpy.mock.calls
      .map((call) => String(call[0]))
      .find((candidate) => candidate.includes('"event":"request_failed"'));
    expect(line).toBeTruthy();
    const record = JSON.parse(line!);
    expect(record).toMatchObject({
      event: "request_failed",
      requestId,
      routeClass: "other",
      status: 500,
    });
    expect(line).not.toContain(WORKSPACE_KEY);
    plane.stores.close();
  });

  it("stays silent on 4xx", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const plane = createDeploymentControlPlane({ OMA_HOME: tempModelHome() });
    const res = await plane.app.request("/no-such-route");
    expect(res.status).toBe(404);
    expect(
      errorSpy.mock.calls.some((call) => String(call[0]).includes("request_failed")),
    ).toBe(false);
    plane.stores.close();
  });
});
