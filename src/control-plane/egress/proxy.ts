// Public egress-proxy surface (plan 0117a). OMA control-plane code imports the
// vendored srt proxy stack ONLY through this module, never from ./vendor/
// directly — so the vendored implementation stays behind a seam we can re-pin
// (ADR 0016 §1) without touching call sites. Policy resolution and provider
// wiring land in later slices (0117c/d); this slice is the vendor + this
// surface + a contract test.
export {
  createHttpProxyServer,
  type HttpProxyServerOptions,
} from "./vendor/http-proxy.ts";
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
