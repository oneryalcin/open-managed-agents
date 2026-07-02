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
import {
  createHttpProxyServer,
  type HttpProxyServerOptions,
} from "./vendor/http-proxy.ts";
import { createPinnedLookup } from "./ssrf.ts";

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

// The OMA-facing options: the raw vendor constructor is fail-open on auth
// (`checkAuth` returns true when `proxyAuthToken` is unset) and supports
// upstream-proxy chaining OMA v1 does not use (and which the vendor does not
// honor on the TLS-terminated leg). This wrapper closes both: it mandates a
// non-empty per-session token and structurally forbids `parentProxy`.
export type EgressProxyOptions = Omit<
  HttpProxyServerOptions,
  "parentProxy" | "proxyAuthToken"
> & {
  /** Mandatory per-session bearer token; the vendor default (unset) is fail-open. */
  proxyAuthToken: string;
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
  // Defensive against JS callers who bypass the Omit type: OMA v1 does not do
  // upstream-proxy chaining, and the vendor ignores it on the terminated leg.
  if ((options as { parentProxy?: unknown }).parentProxy !== undefined) {
    throw new Error(
      "createEgressProxy does not support parentProxy: upstream-proxy chaining " +
        "is unused in OMA v1 and is not honored on the TLS-terminated leg.",
    );
  }
  // SSRF/private-IP deny by default (ADR 0016 §5): unless the caller supplies
  // its own lookup, every upstream dial resolves through a validating lookup
  // that denies private/loopback/reserved targets and pins the vetted IP. A
  // caller CAN override `lookup` (tests reaching a loopback fixture do), which
  // is why this is a default, not a hard-wire.
  return createHttpProxyServer({
    lookup: createPinnedLookup(),
    ...options,
  });
}
