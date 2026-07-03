// Public egress-proxy surface (plan 0117a). OMA control-plane code imports the
// vendored srt proxy stack ONLY through this module, never from ./vendor/
// directly — so the vendored implementation stays behind a seam we can re-pin
// (ADR 0016 §1) without touching call sites.
//
// NOT YET A COMPLETE EGRESS BOUNDARY. The proxy is vendored (0117a) with a safe
// constructor and, as of 0117b, a default SSRF/private-IP deny (see below).
// Still owed: egress policy + credential injection (0117c) and Docker
// proxy-only-egress wiring (0117d). Until those land, `createEgressProxy` is a
// building block, not the wired control-plane boundary.
import { isIP } from "node:net";
import {
  createHttpProxyServer,
  type HttpProxyServerOptions,
} from "./vendor/http-proxy.ts";
import { createPinnedLookup, isBlockedAddress } from "./ssrf.ts";

export {
  createMitmCA,
  disposeMitmCA,
  type MitmCA,
} from "./vendor/mitm-ca.ts";
export type {
  FilterRequestCallback,
  RequestDecision,
  MutateForwardedHeaders,
} from "./vendor/request-filter.ts";

// The OMA-facing options. The raw vendor constructor exposes several settings
// that would undermine the boundary "by construction", so they are removed from
// this surface and enforced here instead:
//   - `proxyAuthToken` — vendor default is fail-open; made mandatory + non-empty.
//   - `parentProxy` — upstream chaining OMA doesn't use and the vendor ignores
//     on the terminated leg; forbidden.
//   - `lookup` — must NOT be caller-overridable, or a caller could replace the
//     SSRF-validating resolver and reach private space. The pinned lookup is
//     applied here, after options, so it always wins.
//   - `getMitmSocketPath` — routes dials through an external MITM unix socket
//     that bypasses the pinned lookup; OMA uses in-process `mitmCA` instead.
export type EgressProxyOptions = Omit<
  HttpProxyServerOptions,
  "parentProxy" | "proxyAuthToken" | "lookup" | "getMitmSocketPath"
> & {
  /** Mandatory per-session bearer token; the vendor default (unset) is fail-open. */
  proxyAuthToken: string;
  /**
   * TEST ONLY. Disables the private-IP protection so an in-process loopback
   * fixture is reachable. NEVER set in production — it turns off the SSRF deny.
   * The name is deliberately loud and greppable.
   */
  dangerouslyAllowPrivateAddressesForTest?: boolean;
};

export function createEgressProxy(options: EgressProxyOptions) {
  if (
    typeof options.proxyAuthToken !== "string" ||
    options.proxyAuthToken.trim() === ""
  ) {
    throw new Error(
      "createEgressProxy requires a non-empty proxyAuthToken — the vendored " +
        "proxy is fail-open (any host process could reach it) without one.",
    );
  }
  // Defensive against JS callers who bypass the Omit type. Both routes would
  // move dials outside the pinned-lookup SSRF check, so reject them at runtime.
  const raw = options as { parentProxy?: unknown; getMitmSocketPath?: unknown; lookup?: unknown };
  if (raw.parentProxy !== undefined) {
    throw new Error(
      "createEgressProxy does not support parentProxy: upstream-proxy chaining " +
        "is unused in OMA v1 and is not honored on the TLS-terminated leg.",
    );
  }
  if (raw.getMitmSocketPath !== undefined) {
    throw new Error(
      "createEgressProxy does not support getMitmSocketPath: an external MITM " +
        "unix-socket route bypasses the pinned-lookup SSRF check. OMA terminates " +
        "TLS in-process via mitmCA.",
    );
  }
  if (raw.lookup !== undefined) {
    throw new Error(
      "createEgressProxy does not accept a caller lookup: it would replace the " +
        "SSRF-validating resolver. Use dangerouslyAllowPrivateAddressesForTest " +
        "for loopback fixtures.",
    );
  }
  // SSRF/private-IP deny by default (ADR 0016 §5), in two halves:
  //
  //   1. DNS names: unless the caller overrides `lookup`, every upstream dial
  //      resolves through a validating lookup that denies private/loopback/
  //      reserved targets and pins the vetted IP.
  //   2. IP LITERALS: Node structurally skips the `lookup` hook when the host
  //      is already a numeric literal (verified), so a literal like
  //      `169.254.169.254` would bypass half 1 entirely. Both the CONNECT and
  //      plain-HTTP handlers call `filter(port, host)` before dialing, so we
  //      wrap the caller's filter to also deny blocked IP literals. This is the
  //      literal half of the deny and covers every dial path.
  const callerFilter = options.filter;
  const guardedFilter: HttpProxyServerOptions["filter"] = (port, host, socket) => {
    const family = isIP(host);
    if (family !== 0 && isBlockedAddress(host, family)) return false;
    return callerFilter(port, host, socket);
  };
  // The pinned lookup is set AFTER spreading options so a caller cannot replace
  // it. The only relaxation is the loud test flag, which turns off the private-IP
  // half (loopback fixtures) — the literal filter-wrap still runs regardless.
  const lookup = options.dangerouslyAllowPrivateAddressesForTest
    ? createPinnedLookup({ allowAddress: () => true })
    : createPinnedLookup();
  const { dangerouslyAllowPrivateAddressesForTest: _omit, ...rest } = options;
  return createHttpProxyServer({
    ...rest,
    filter: guardedFilter,
    lookup,
  });
}
