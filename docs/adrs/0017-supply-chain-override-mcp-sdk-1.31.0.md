# ADR 0017: Supply-chain override for @modelcontextprotocol/sdk 1.31.0

**Status:** Accepted, 2026-10-08

## Context

The repo's supply-chain policy is a 30-day minimum release age
([ADR 0006](0006-one-time-supply-chain-override-pi-0.75.4.md)): a version
younger than 30 days is installed only by a documented, deliberate override.

`npm audit` reports a high-severity advisory against
`@modelcontextprotocol/sdk` `>=1.12.0 <1.31.0`: the OAuth client could send
credentials to an authorization server chosen by the MCP server. OMA uses that
client in production, in `src/control-plane/vaults/console-mcp-oauth.ts`
(`@modelcontextprotocol/sdk/client/auth.js`). The first fixed release, 1.31.0,
was published 2026-09-28, which is 10 days old today. The newest
policy-eligible release, 1.30.0, is still vulnerable.

## Decision

Install `@modelcontextprotocol/sdk@1.31.0` now, pinned exactly. Do not wait
for it to become eligible on 2026-10-28.

- Only this package is exempt. It was installed with
  `npm install --before=2026-09-29`, so its own new transitive dependencies
  could not resolve to anything newer than the package itself.
- Every other bump in the same change was installed with
  `--before=2026-09-08`. A lockfile scan confirmed that 1.31.0 is the only
  changed package younger than 30 days.

## Why not wait

The advisory is in the OAuth flow OMA runs on behalf of operators. The other
transitive MCP SDK advisories (`ip-address`, `proxy-addr`, `fast-uri`, `qs`)
come from the SDK's server-side Express stack, which OMA imports only in a
test fixture, so they do not justify an override and wait for their fixes to
age.

## Consequences

- The lockfile pins the exact integrity hash. `npm ci` reproduces it.
- This is not a precedent: the next override needs its own record.
- **Policy enforcement gap (found while making this change):** npm 11.7.0
  reports `min-release-age` as an unknown config and does not enforce it, and
  the user-level value is 5, not 30. Until that is fixed, dependency changes
  in this repo must pass `--before=<today − 30 days>` explicitly, or a plain
  install can pull versions only days old. That happened on the first attempt
  of this change: a `vitest` bump re-resolved `vite`/`rolldown` to versions
  1–2 days old.
