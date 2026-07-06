// SSRF-guarded fetch for control-plane MCP dials (plan 0122 §4.3).
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
} from "../../../egress/ssrf.ts";

/** Matches the MCP SDK's FetchLike. */
export type McpFetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export function createGuardedMcpFetch(opts: PinnedLookupOptions = {}): McpFetch {
  const dispatcher = new Agent({
    connect: { lookup: createPinnedLookup(opts) },
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
