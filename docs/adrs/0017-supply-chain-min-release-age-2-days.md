# ADR 0017: Supply-chain minimum release age is 2 days, enforced by npm

**Status:** Accepted, 2026-10-08. Amends
[ADR 0006](0006-one-time-supply-chain-override-pi-0.75.4.md).

## Context

ADR 0006 records a 30-day `min-release-age` policy: npm refuses any package
version younger than that, because compromised releases are usually caught and
yanked within days. Two findings on 2026-10-08:

1. **The policy was not enforced at all.**
   - The global npm on the maintainer's PATH (11.7.0) reported
     `min-release-age` as an unknown config and ignored it.
   - The configured value was 5, not 30.
   - A routine `vitest` bump then pulled `vite`/`rolldown` versions 1–2 days
     old.
2. **30 days was too aggressive for security fixes.** The fix for a
   high-severity MCP SDK OAuth advisory (1.31.0, in code OMA runs) was 10 days
   old and would have needed a written override.

## Decision

- **The minimum release age is 2 days.** That is long enough for the usual
  window in which malicious publishes are detected and yanked, and short
  enough that security fixes land without ceremony.
- **It is enforced at three points:**
  - **Resolution:** the committed project `.npmrc` sets `min-release-age=2`, so
    `npm install`/`npm update` refuse young versions for every contributor on
    npm >= 11.10. The maintainer's user-level `.npmrc` matches. Verified: a
    version published that day is refused (`notarget … with a date before …`)
    and a 9-day-old version installs.
  - **Pull requests:** `npm ci` does *not* re-check lockfile entries (verified:
    it installs a same-day version pinned in the lockfile). So CI runs
    `scripts/check-lockfile-age.mjs`, which fails a PR whose lockfile adds any
    version younger than 2 days.
  - **Tooling:** npm must honour the key (11.10+; 11.21.0 installed locally;
    CI's Node 24.18.0 bundles 11.16.0).
- **Overrides still follow ADR 0006's process,** but now only for versions
  younger than 2 days. An approved override is listed as `name@version` in
  `.lockfile-age-allow`.
- If npm reports `Unknown user config "min-release-age"`, enforcement is off.
  Treat that as a broken environment, not a warning.

## Consequences

- `@modelcontextprotocol/sdk@1.31.0` (#238) and Pi 0.85.1 are within policy;
  no override is needed.
- The policy now governs lockfile changes in CI, not just local installs.
