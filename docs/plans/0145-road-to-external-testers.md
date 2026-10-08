# 0145 — Road to external testers

## Status

Planning document, written 2026-10-08. It sequences the remaining pre-v1 work
so that external alpha testers ([ALPHA.md](../../ALPHA.md), #196) meet a
build with as few known trust gaps as possible. The maintainer is **tester
zero**: every milestone ends with the maintainer running the public onboarding
path against the released package before anyone else is asked to.

It does not replace [0114](0114-appliance-product-roadmap.md) (product arcs)
or [PARITY.md](../../PARITY.md) (parity scorecard). It orders their open items
and today's review follow-ups into releases.

## Where we start (2026-10-08)

- `main` carries a large unreleased delta. npm `latest` is still **0.1.2
  (2026-07-22)**. Unreleased: Pi 0.85.1 (#239); dependency security fixes and
  the enforced 2-day release-age policy (#238, ADR 0017); the upload
  materialization fix (#235); rootless Podman (#236); the delete-after-idle
  race fix (#240); the MCP OAuth console lifecycle (#228); full-suite CI with
  hermetic tests (#241).
- The synchronous single-agent core is strong. Gaps are concentrated in
  trust edges, a few visible capabilities, and orchestration/persistence (see
  PARITY.md's scorecard).
- Usage is near zero, so there is no release pressure. A release only needs
  to be worth testing.

## Principles

1. **Trust before capability.** PARITY.md's bar applies: a request on the
   exposed surface must not succeed while silently doing nothing or the
   opposite. Trust gaps a tester can hit go before new features.
2. **Each milestone ends in a release and a tester-zero run.** The maintainer
   runs the public `npx --yes open-managed-agents@latest` path, the
   packed-package browser lane, and a short scripted session (coding task with
   files, a tool confirmation, an MCP server, delete after idle), and records
   the result here.
3. **The gauntlet before merge.** Codex review + adversarial pass plus an
   independent reviewer, then each finding verified with a red/green test.
   Full-suite CI is green.
4. **Decisions are recorded, not drifted into.** Direction items below get an
   ADR or an amendment before code.

## M1 — 0.2.0 "trust release"

Goal: nothing a first tester touches lies about state or leaks credentials.

| Item | Why it blocks | Notes |
|---|---|---|
| #245 parallel turns: session reports idle while a turn runs | Breaks the core loop's contract; SDK clients wait for idle | Probe hosted CMA first: what does a mid-turn `user.message` do (queue, reject, interleave)? Then serialize turns per session, or publish idle only when no task is live |
| #242 MCP OAuth reauthorize: persist the authorization-server issuer | Credential-leak path (hostile MCP server can redirect reauthorize) | Vault credential schema change + migration for unstamped credentials; regression test with a moved `authorization_servers` |
| Release checklist | Ship the unreleased delta | `make npm-release-check`, version 0.2.0 (async construction APIs and Pi changed under the hood), changelog, `make npm-release-verify` from the registry |
| Tester-zero run on 0.2.0 | Proves the public path, not the source path | Record timings and any manual intervention in this document |

Explicitly **not** in M1: #177 (microsandbox is offline-only/limited support),
#152/#153 (admin hardening matters for multi-operator deployments), all of
M2.

## M2 — 0.3.0 "capability release"

Goal: an agent can do a realistic coding task end to end, and the operator can
see what it cost.

| Item | Notes |
|---|---|
| #164 split `events/service.ts` | **First in M2.** The delete race, per-task idle state and parallel turns all lived in this god class. Split the three persist-and-claim state machines before more features land on it |
| Web tools (`web_fetch` / `web_search`) | PARITY pre-v1 arc 3: re-probe CMA shapes; decide which tools are honest to offer through the egress boundary |
| Usage metering (0114 Arc D) | Sessions still return `usage: null`. Aggregate the span-level model usage already captured; surface it in the console |
| Environment resource (packages / runtimes) | Environments are ~35% parity; decide the image/package story beyond the single coding image |
| Session surface gaps | Update, overrides and `resources.*` (~65% parity); pick what a tester needs, defer the rest with honest 400s |
| 0114 Arc A leftover | Compose + docs for docker-local egress in the container deployment (docker.sock, `OMA_EGRESS_SIDECAR_IMAGE`, `OMA_MASTER_KEY`) |

## M3 — hardening before external testers

Goal: close the remaining known issues that an outside tester's environment
could expose.

- #246 gVisor (`runsc`) support: egress sidecar by IP, runtime knob, CI leg
- #244 running from source on Node 26 (prefer erasable-only TypeScript)
- #177 + #204 microsandbox: root-owned skills mount, fail-closed HTTPS egress
- #152 / #153 admin API: key-mint idempotency guard, audit lines for denied attempts
- #247 remaining idle-emission paths (or publish idle after output indexing)
- #248 Pi 0.85 follow-ups; #250 remaining audit findings; #251 microsandbox `setsid`

## Decisions to make (ADR before code)

| Decision | Inputs | When |
|---|---|---|
| Session parking: idle sessions on `requires_action` must not hold a running container | #229 (park/resume contract in 0107), #230 (durability and parking as one design), Substrate/celld prior art | Before M2 ends; it shapes #164's split |
| Remote / hosted sandbox tier in scope before v1? | ADR 0003 amendment (Modal is an open question), 0106 hosted matrix, K8s `agent-sandbox` target | Before any provider work after M3 |
| Pi 1.x | #249: Pi 1.0.1 drops its shrinkwrap; ADR 0006/0017 pinning | After 0.2.0; not bundled with other changes |

## Gate for external testers

Recruit external testers (#196's three non-maintainer warm-path observations)
when all of these hold:

- M1 and M2 released; M3's items closed or explicitly accepted as known issues
  in the tester brief.
- Tester-zero runs on the latest release meet the three-minute warm path
  without undocumented intervention.
- The packed-package browser lane passes in CI.
- A one-page tester brief: what to try, what is deliberately unsupported
  (PARITY.md), how to report.

## Deferred to post-v1

Multi-agent delegation (#214), GitHub repository resources (#213), memory and
dreams (#212), webhooks (#211), scheduled deployments (#210), outcomes and
evaluation (#215).

## Tester-zero log

Record each run: date, release, path (npx / packed / source), time to first
session, interventions needed, issues filed.

| Date | Release | Path | Time to session | Interventions | Issues |
|---|---|---|---|---|---|
| | | | | | |
