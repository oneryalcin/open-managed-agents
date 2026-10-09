// SSRF-guarded fetch for control-plane dials: MCP (plan 0122 §4.3) and web
// tools (plan 0149).
//
// Agent configs carry attacker-influenceable URLs and the control plane dials
// them; without a guard, `http://169.254.169.254/` or the admin API would be
// reachable. The transport takes a custom fetch, so we hand it one whose
// dialer resolves through the egress pinned lookup: every resolution is
// checked against the blocked ranges, and the socket connects to exactly the
// vetted address (Node's `lookup` seam — no re-resolution between check and
// connect, so no TOCTOU). Probe-verified (2026-07-06): undici re-consults the
// lookup per new connection, so a DNS rebind to a private range is re-checked
// and rejected, and `redirect: "error"` refuses the classic 30x-to-internal
// bypass.
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import {
  createPinnedLookup,
  isBlockedAddress,
  type PinnedLookupOptions,
} from "./ssrf.ts";
import type { WebUrlCheck } from "./web-url.ts";

/** Matches the MCP SDK's FetchLike. */
export type GuardedFetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export function createGuardedFetch(opts: PinnedLookupOptions = {}): GuardedFetch {
  const dispatcher = new Agent({
    connect: { lookup: ipv4FirstLookup(createPinnedLookup(opts)) },
  });
  return async (url, init) => {
    // Node skips the lookup seam entirely for IP-literal hostnames, so a
    // `http://127.0.0.1/…` target would bypass a lookup-only guard. Check
    // literals explicitly, same as egress/proxy.ts does before dialing.
    assertLiteralHostAllowed(url, opts);
    return undiciFetch(url, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      // After the init spread: callers (including the MCP SDK) can never
      // relax the dialer or re-enable redirects.
      dispatcher,
      redirect: "error",
    }) as unknown as Promise<Response>;
  };
}

/**
 * Reorder vetted addresses IPv4-first. Live smoke 48: dual-stack MCP hosts
 * (e.g. DeepWiki on AWS) resolve v6-first, and on networks without working
 * v6 egress each new connection burned ~15s of v6 SYN timeouts before
 * falling back — racing the MCP handshake into its request timeout. Every
 * address here has already passed the blocked-range check; only the dial
 * order changes.
 */
function ipv4FirstLookup(inner: ReturnType<typeof createPinnedLookup>) {
  return ((hostname, options, callback) => {
    inner(hostname, options, (err, address, family) => {
      if (err || !Array.isArray(address)) {
        callback(err, address, family);
        return;
      }
      const sorted = [
        ...address.filter((entry) => entry.family === 4),
        ...address.filter((entry) => entry.family !== 4),
      ];
      callback(null, sorted);
    });
  }) as ReturnType<typeof createPinnedLookup>;
}

function assertLiteralHostAllowed(
  url: string | URL,
  opts: PinnedLookupOptions,
): void {
  const parsed = typeof url === "string" ? new URL(url) : url;
  // URL.hostname wraps IPv6 literals in brackets; strip for isIP.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  if (family === 0) return; // not a literal — the pinned lookup handles it
  if (opts.allowAddress?.(host, family)) return;
  if (!isBlockedAddress(host, family)) return;
  throw Object.assign(
    new Error(
      `egress denied: ${host} is in a blocked (private/loopback/reserved) range`,
    ),
    { code: "EGRESS_SSRF_BLOCKED" },
  );
}

// ---------------------------------------------------------------------------
// Web tools (plan 0149): a fetch that follows redirects itself, so every hop
// goes through the caller's URL validator before it is dialed, and caps time
// and bytes while streaming (Content-Length is not trusted).

export interface WebFetchOptions {
  /** Runs on the requested URL and on every redirect target, before dialing. */
  validate: (raw: string) => WebUrlCheck;
  /** Test-only SSRF escape hatch; never set in production. */
  guard?: PinnedLookupOptions;
  maxRedirects?: number;
  maxBytes?: number;
  /** Total time across all hops, including reading the body. */
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export type WebFetchResult =
  | {
      ok: true;
      finalUrl: string;
      status: number;
      contentType: string | null;
      body: Uint8Array;
      truncated: boolean;
    }
  | {
      ok: false;
      code:
        | "url_not_allowed"
        | "url_too_long"
        | "invalid_url"
        | "too_many_redirects"
        | "timeout"
        | "aborted"
        | "fetch_failed";
      reason: string;
      url: string;
    };

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;
let sharedWebDispatcher: Agent | undefined;

export async function fetchWebResource(
  requested: string,
  opts: WebFetchOptions,
): Promise<WebFetchResult> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal === undefined ? timeout : AbortSignal.any([opts.signal, timeout]);
  const dispatcher = opts.guard === undefined
    ? (sharedWebDispatcher ??= webDispatcher({}))
    : webDispatcher(opts.guard);
  let current = requested;
  for (let hop = 0; ; hop += 1) {
    let check: WebUrlCheck;
    try {
      check = opts.validate(current);
    } catch (error) {
      return { ok: false, code: "invalid_url", reason: error instanceof Error ? error.message : String(error), url: current };
    }
    if (!check.ok) return { ok: false, code: check.code, reason: check.reason, url: current };
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      assertLiteralHostAllowed(check.url, opts.guard ?? {});
      response = await undiciFetch(check.url, {
        dispatcher,
        redirect: "manual",
        signal,
        ...(opts.headers === undefined ? {} : { headers: opts.headers }),
      });
    } catch (error) {
      return failure(error, current, signal, opts.signal);
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel().catch(() => {});
      if (hop >= maxRedirects) {
        return { ok: false, code: "too_many_redirects", reason: `more than ${maxRedirects} redirects`, url: current };
      }
      try {
        current = new URL(location, check.url).href;
      } catch {
        return { ok: false, code: "invalid_url", reason: `malformed redirect location: ${location.slice(0, 100)}`, url: current };
      }
      continue;
    }
    try {
      const { body, truncated } = await readCapped(response.body, maxBytes);
      return {
        ok: true,
        finalUrl: check.url.href,
        status: response.status,
        contentType: response.headers.get("content-type"),
        body,
        truncated,
      };
    } catch (error) {
      return failure(error, current, signal, opts.signal);
    }
  }
}

function webDispatcher(guard: PinnedLookupOptions): Agent {
  return new Agent({ connect: { lookup: ipv4FirstLookup(createPinnedLookup(guard)) } });
}

async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ body: Uint8Array; truncated: boolean }> {
  if (stream === null) return { body: new Uint8Array(), truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { body: concat(chunks, size), truncated: false };
    const room = maxBytes - size;
    if (value.byteLength >= room) {
      chunks.push(value.subarray(0, room));
      // Exactly full: truncated only if more would have followed.
      const more = value.byteLength > room || !(await reader.read()).done;
      await reader.cancel().catch(() => {});
      return { body: concat(chunks, maxBytes), truncated: more };
    }
    chunks.push(value);
    size += value.byteLength;
  }
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function failure(
  error: unknown,
  url: string,
  signal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): WebFetchResult {
  if (callerSignal?.aborted) return { ok: false, code: "aborted", reason: "the request was cancelled", url };
  if (signal.aborted) return { ok: false, code: "timeout", reason: "the request timed out", url };
  const ssrf = findCode(error) === "EGRESS_SSRF_BLOCKED";
  return ssrf
    ? { ok: false, code: "url_not_allowed", reason: "the host resolves to a private or reserved address", url }
    : { ok: false, code: "fetch_failed", reason: error instanceof Error ? error.message : String(error), url };
}

function findCode(error: unknown): unknown {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (code !== undefined) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
