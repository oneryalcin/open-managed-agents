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

## Result: 8/8, deterministic across two runs

| Check | Result | Evidence |
|---|---|---|
| (a) allowlisted host reachable via TLS termination | PASS | container curl exit 0; upstream saw the request |
| (d1) upstream observed the REAL secret | PASS | echo saw `Authorization: Bearer real-secret-…` |
| (d2) boundary received only the SENTINEL from the container | PASS | `mutateHeaders` saw exactly `["Bearer srt-sentinel-…"]` |
| (d3) reflective upstream returns the real secret in the response | PASS (expected caveat) | echo reflected the injected header — inherent, documented |
| (b) non-allowlisted host denied | PASS | `curl: (7) CONNECT tunnel failed, response 403` |
| (c) redirect to non-allowlisted host denied on re-entry | PASS | echo returned 302→example.com; the follow-up CONNECT got 403 |
| (e) missing proxy auth rejected | PASS | `curl: (7) CONNECT tunnel failed, response 407` |
| (f) no post-resolution private-IP deny in srt | PASS (documented gap) | allowlisted loopback served fine; smokescreen-style check is OMA's to add |

## What this confirms for the ADR

- **The survey's chosen architecture works as specified.** Hostname allowlist
  (`filter`), full-URL policy on the decrypted request (`filterRequest`), TLS
  termination with cert-verified upstream, per-request redirect re-evaluation,
  per-session proxy auth token, and sentinel→real substitution at the boundary
  (`mutateHeaders`) all behave as the survey claimed — verified, not recalled.
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
