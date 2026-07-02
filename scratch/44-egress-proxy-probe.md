# Probe 44 — srt egress-proxy confidence probe

Date: 2026-07-02
Script: `scratch/44-egress-proxy-probe.ts`
Context: 0114 capability track; the "next step 1" from
[egress-secrets-buy-vs-build.md](../docs/references/egress-secrets-buy-vs-build.md);
closes half of #130's acceptance criteria (proves OMA-level boundary injection
works, so provider-carried secret proxy can be ruled out in the ADR).

## Question

Does `@anthropic-ai/sandbox-runtime`'s proxy stack — driven directly (deep
`dist/` import, unsupported API, the vendoring shape the survey chose) —
enforce the egress + secret-injection invariants against a **real Docker
container** as the client?

## Result: 9/9 enforcement checks, deterministic

| Check | Result | Evidence |
|---|---|---|
| (a) allowlisted host reachable via TLS termination | PASS | container curl exit 0; upstream saw the request |
| (d1) upstream observed the REAL secret | PASS | echo saw `Authorization: Bearer real-secret-…` |
| (d2) boundary received only the SENTINEL from the container | PASS | `mutateHeaders` saw exactly `["Bearer srt-sentinel-…"]` |
| (d3) reflective upstream returns the real secret in the response | PASS (documents the caveat) | echo reflected the injected header — inherent, documented |
| (b) non-allowlisted host denied at CONNECT (403) | PASS | `curl: (7) CONNECT tunnel failed, response 403` — asserts the explicit 403, so a DNS/network/TLS failure can't false-green |
| (b2) allowlisted host + disallowed **path** denied by `filterRequest` (403) | PASS | `http_code=403`; `filterRequest` recorded the `/blocked` denial — exercises the per-request-policy DENY branch |
| (c) redirect to non-allowlisted host denied (403) on re-entry | PASS | echo returned 302→example.com; the follow-up CONNECT got an explicit 403 |
| (e) missing proxy auth rejected (407) | PASS | `curl: (7) CONNECT tunnel failed, response 407` |
| (g) verify-before-inject: wrong upstream CA fails, secret never leaves | PASS | `http_code=502`; echo request count unchanged — mutation-verified (correct CA → echo receives it, 200, check flips) |

NOTE (not a counted check): srt has **no** post-resolution private-IP deny — the
allowlisted loopback target was served with no objection. A confirmed gap; the
smokescreen-style connect-to-pinned-IP check is OMA's to add.

## Scope limit (review-driven)

This probe validates the **proxy's behavior for a proxy-honoring client**. The
container uses default Docker networking and is only pointed at the proxy via
`HTTPS_PROXY`; it is NOT route-confined (verified: `docker run curl
https://example.com` with no proxy returns 200). A non-compliant client
(raw sockets, `curl --noproxy '*'`, cleared env) could egress directly.
**Route-level confinement — the `--network none` → proxy-only-egress shape — is
ADR 0016 implementation work, not proven here.** The deny checks (b)/(c)/(e)
assert the explicit 403/407 the proxy's policy branch emits (only the proxy
produces it, and the CONNECT is rejected at the hostname filter before the
target is resolved), so they cannot pass on a generic network failure;
mutation-verified by flipping the allowlist to accept-all, which drops (b)/(c).

## What this confirms for the ADR

- **The survey's chosen architecture works as specified.** Hostname allowlist
  (`filter`, check b), full-URL path policy on the decrypted request
  (`filterRequest` DENY branch, check b2), TLS termination with cert-verified
  upstream (check g, verify-before-inject), per-request redirect re-evaluation
  (check c), per-session proxy auth token (check e), and sentinel→real
  substitution at the boundary (`mutateHeaders`, checks d1/d2) all behave as
  the survey claimed — each with its own enforcement check, not recalled.
  Caveat: path policy and injection apply only to terminated TLS; srt falls
  back to an opaque tunnel for TLS-termination opt-outs and non-TLS CONNECT
  bytes (documented in ADR 0016 §3).
- **The credential boundary holds.** The container's env carried only the
  sentinel; the real secret existed solely in the host proxy process; the
  upstream received the real value. (d2) is the load-bearing proof.
- **The reflective-upstream caveat is real and bounded** (d3). Because srt
  pipes upstream responses back unmodified, an upstream that echoes the
  injected header returns the real secret into the sandbox. This is inherent
  to boundary injection, already recorded in the survey and threat model. The
  ADR must (a) only inject toward non-reflective hosts by policy, and (b)
  decide whether OMA adds response redaction (Osaurus prior art).
- **srt has no SSRF/private-IP defense** (f). The proxy happily served a
  loopback target because it was allowlisted; there is no post-DNS-resolution
  IP check. OMA must add the smokescreen-style private-range deny (~50 lines)
  in the `filterRequest`/`filter` layer.

## Process notes (for the writeup, and for future probes)

- **Self-inflicted deadlock, twice.** The first two runs failed every
  network check with 15s timeouts. Cause was NOT the proxy and NOT OrbStack
  networking (I wrongly blamed both mid-probe): the client was driven with
  `execFileSync`, which blocks the Node event loop, so the proxy running in
  the **same process** could never accept the connection. This is the exact
  `execFileSync`-blocks-the-loop class the auth arc already hit. Fix: drive
  the container with async `spawn`. An async reachability re-test then showed
  OrbStack container→host works fine — the earlier "OrbStack is broken"
  diagnosis was an artifact of the same deadlock in the throwaway test.
  Lesson reinforced: when the server-under-test and the client live in one
  process, the client MUST be async.
- The container names `localhost` in CONNECT; the **proxy** (on the host)
  resolves it to the echo server, so the container never reaches the upstream
  directly — the elegant part of the CONNECT-allowlist shape.
- Deep `dist/` import is unsupported API (no `exports` map, `createHttpProxyServer`
  not re-exported) — fine for a probe, and exactly why the survey's plan is to
  **vendor** the ~1,250 LOC rather than depend on it.

## Verdict

Green light for the egress ADR on the survey's terms. Vendor the srt proxy
stack; add the private-IP deny; carry the reflective-upstream redaction
question into the ADR as an explicit decision.
