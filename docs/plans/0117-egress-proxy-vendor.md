# 0117 Egress proxy vendor + credentialed egress

Date: 2026-07-03

Implements: [ADR 0016](../adrs/0016-egress-proxy-and-secret-injection.md).
Roadmap: capability track of the [0114 roadmap](0114-appliance-product-roadmap.md).
Delivers with [0118 SecretsStore](#) the "credentialed egress" capability:
an operator grants a sandboxed agent credentialed access to an allowlisted
host without the agent ever seeing the key.

## Vendoring spike (2026-07-03)

Confirmed the srt proxy stack lifts cleanly. Import graph of the six proxy
files is closed over: `http-proxy`, `tls-terminate-proxy`, `mitm-ca`,
`request-filter`, `parent-proxy`, `mitm-leaf` (~1,460 LOC), plus one internal
`utils/debug.js` (a 20-line `SRT_DEBUG` stderr logger). Only external dep is
**`node-forge@1.4.0`** (cert minting for the MITM CA). No `zod`/`commander`/
`socks5-server` — those are the CLI and SOCKS paths, which the HTTP proxy does
not use. Public entry we drive: `createHttpProxyServer(options)` from
`http-proxy` and `createMitmCA`/`disposeMitmCA` from `mitm-ca` (probe 44 drove
exactly these).

## Decisions

- **Vendor the `.ts` source** from the pinned tag (srt `0.0.63`) into
  `src/control-plane/egress/vendor/`, with a `VENDOR.md` recording the tag, the
  upstream commit, the file list, and the diff-on-release tracking commitment
  from ADR 0016 §1. Fall back to the shipped `dist/*.js` + `*.d.ts` only if the
  source is not cleanly fetchable. Keep the vendored files as verbatim as
  possible so upstream diffs stay legible; OMA-specific changes live in a thin
  wrapper module, not edits to the vendored files (exception: the two
  hardening changes below, which must be marked with `// OMA:` comments).
- **Replace `utils/debug.js`** with a one-line shim to OMA's logger rather than
  vendoring srt's — it is the only cross-cutting import and stubbing it keeps
  the dep surface to `node-forge` alone.
- **`node-forge` becomes a direct `dependency`** (not dev) — it is now runtime
  code. Pin the exact version.
- The srt package **stays a devDependency** for the probes (`scratch/44`),
  which keep driving upstream directly as a drift check against our vendored
  copy.

## Sub-slices (each its own PR)

### 0117a — Pure vendor, no behavior change

Copy the six files + a debug shim into `src/control-plane/egress/vendor/`,
add `node-forge`, expose a thin `createEgressProxy` wrapper. Typecheck clean.
A port of probe 44's happy path becomes a real contract test
(`egress/__tests__/`) so the vendored code is exercised in CI, not just by the
scratch probe. No control-plane wiring yet.

### 0117b — SSRF/private-IP deny in the dial path (ADR 0016 §5)

The load-bearing correctness item. Implement **resolve-once → validate every
resolved IP against a private/loopback/link-local/ULA blocklist → connect to
the pinned IP**, hostname preserved only as TLS `servername`/SNI; handle
multiple A records and IPv6. This edits the vendored dial path (marked `// OMA:`)
— a filter-only check re-opens DNS rebinding (the TOCTOU the reviews caught).
Contract tests: an allowlisted name resolving to a private IP is denied; a
rebinding flip between resolve and connect cannot reach the private IP; a
public host still works.

### 0117c — Egress policy as data + resolution

Define the serializable egress policy (allowlist entries: host + optional path
prefix; credential grants: sentinel → secret ref + inject hosts, **path/method
scoped** per ADR 0016 §6). Resolve it from the authenticated workspace + the
session environment's `networking` config. Reject non-TLS CONNECT payloads
unless a host is explicitly flagged (ADR 0016 §3 opaque-tunnel boundary).
Credential grants resolve their secret ref against `SecretsStore` (0118) — so
0117c depends on 0118 landing first, or stubs the resolver behind an interface.

### 0117d — Wire proxy-only egress into the Docker provider

Replace `--network none` with a proxy-only internal network for environments
that grant egress (default stays `--network none`, ADR 0016 §2). Inject the
per-session MITM CA into the sandbox trust bundle and the `HTTPS_PROXY` +
per-session proxy-auth token. **The confinement test ADR 0016 owes**: a client
with proxy env removed / using raw sockets cannot egress directly.

## Tests owed (from ADR 0016 validation)

- route-level confinement (0117d): proxy env removed / raw socket cannot egress;
- private-IP deny actually denies, incl. the rebinding flip (0117b);
- verify-before-inject holds in the wired path (carry probe 44 (g) into a
  contract test);
- path/method-scoped inject grants deny an off-path request (0117c).

## Non-goals

Skills, MCP, repo mounts (later capability slices). Response redaction (ADR
0016 §6, deferred past v1). Multi-provider egress beyond Docker-local.
