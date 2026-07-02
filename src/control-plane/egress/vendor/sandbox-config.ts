// OMA vendor shim: srt's sandbox-config.ts is a large zod-schema module. The
// only symbol the vendored proxy stack needs is the ParentProxyConfig TYPE
// (used by parent-proxy.ts). Structural definition matching srt v0.0.63's
// ParentProxyConfigSchema (http/https/noProxy, all optional strings). We do not
// vendor the schema module, so no zod dependency is pulled in.
export interface ParentProxyConfig {
  http?: string;
  https?: string;
  noProxy?: string;
}
