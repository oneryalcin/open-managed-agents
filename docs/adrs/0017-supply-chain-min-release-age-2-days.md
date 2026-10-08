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
- **It is enforced by npm itself.**
  - The user-level `.npmrc` sets `min-release-age=2`.
  - npm must be a version that honours the key: 11.19+ does; 11.21.0 is
    installed. Verified: a version published that day is refused (`notarget …
    with a date before …`) and a 9-day-old version installs.
- **Overrides still follow ADR 0006's process,** but now only for versions
  younger than 2 days.
- If npm reports `Unknown user config "min-release-age"`, enforcement is off.
  Treat that as a broken environment, not a warning.

## Consequences

- `@modelcontextprotocol/sdk@1.31.0` (#238) and Pi 0.85.1 are within policy;
  no override is needed.
- CI installs from the committed lockfile (`npm ci`), so the policy governs
  *changes* to the lockfile. A reviewer should check that newly added versions
  in a lockfile diff are at least 2 days old.
