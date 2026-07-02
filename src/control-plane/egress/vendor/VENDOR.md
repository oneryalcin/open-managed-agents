# Vendored: sandbox-runtime egress proxy stack

**Upstream:** [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
**Pinned tag:** `v0.0.63`
**Source:** `src/sandbox/*.ts` at that tag (fetched 2026-07-03).
**License:** Apache-2.0 (upstream `LICENSE`).
**Why vendored, not depended on:** ADR 0016 §1 — srt exports no
`createHttpProxyServer`, has no `exports` map, and self-labels a research
preview. We adopt the code and track upstream.

## Files (verbatim from upstream except the marked changes below)

- `http-proxy.ts` — `createHttpProxyServer` (the entry we drive)
- `tls-terminate-proxy.ts` — in-process TLS termination
- `mitm-ca.ts` — `createMitmCA` / `disposeMitmCA`
- `mitm-leaf.ts` — per-host leaf cert minting
- `request-filter.ts` — the `filterRequest` decision plumbing
- `parent-proxy.ts` — upstream-proxy chaining (unused in OMA v1, kept for
  http-proxy's structural imports)

External runtime dependency: **`node-forge`** (cert minting), now a direct
`dependency` pinned to the version srt used.

## Modifications from upstream (keep this list exhaustive)

1. **Relative import extensions `.js` → `.ts`** across all files. Upstream uses
   ESM `.js` specifiers on relative imports; Node's `--experimental-transform-types`
   (how OMA runs) does not resolve a `.js` specifier to a sibling `.ts`, and our
   codebase uses `.ts` extensions. Uniform mechanical rewrite; grep
   `from '\./.*\.ts'` to see them. `node:` and `node-forge` specifiers untouched.
2. **`../utils/debug.ts`** — a local shim replacing srt's `utils/debug.js`
   (a 20-line `SRT_DEBUG` stderr logger). The only cross-cutting import; stubbing
   it keeps the vendored dep surface to `node-forge` alone.
3. **`sandbox-config.ts`** — a minimal local shim exporting only the
   `ParentProxyConfig` structural type (`{http?, https?, noProxy?: string}`)
   that `parent-proxy.ts` type-imports. Upstream's `sandbox-config.ts` is a
   large zod-schema module; vendoring it would pull in zod. We need only the type.
4. **`http-proxy.ts` one cast** marked `// OMA:` — `head = peeked.head as typeof head`,
   an `@types/node` buffer-variance skew between srt's build env and ours
   (25.6.0). No behavior change.

All changes are marked `// OMA:` in code (except the mechanical `.js`→`.ts`
rewrite and the two shim files, which are noted here).

## Upstream tracking (ADR 0016 §1 commitment)

On each srt release, diff `src/sandbox/*.ts` at the new tag against these files
(accounting for the modifications above) and re-apply deliberately. This is a
security boundary; do not auto-bump.
