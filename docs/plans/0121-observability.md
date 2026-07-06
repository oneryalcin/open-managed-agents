# 0121 — Observability: /health, /metrics, structured logs (Arc C)

Date: 2026-07-06
Roadmap: [0114](0114-appliance-product-roadmap.md) Arc C. This is the
[0112](0112-pi-runtime-rollout-policy.md) gate "Operational observability —
blocks multi-worker/managed production", and it resolves threat-model §5
(log redaction) — per the roadmap, "what we emit and what we persist are one
decision." Arcs A+B are done: the appliance boots, authenticates, and has an
operator console; what it cannot do yet is **report its own state** (roadmap
exit-criterion 2).

**Handoff plan.** `file:line` against `main` at `f2c06e2`; re-confirm before editing.

**Reviewed 2026-07-06** by Codex (review + adversarial), Opus, and Sonnet
before implementation; all findings folded in below, disposition log in §9.
Ships as **two stacked PRs**: C1 (logger + redaction + threat-model §5) and
C2 (endpoints + metrics registry + instrumentation) — see §9 (Opus M4).

---

## 1. Why this slice exists / definition of done

Today the appliance emits ad-hoc `console.warn/error` lines (23 real call
sites outside tests, product output excluded — see §2) and one structured
JSON event (`admin_audit`, `admin/routes.ts:66`). There is no health
endpoint (a load balancer or `docker compose` healthcheck has nothing to
probe), no metrics, no log line when a request 5xxes, and no stated rule
about what may appear in a log line. 0112 names the required telemetry:
**runtime turns, pending waits, sandbox lifecycle, provider errors, reaper
activity.**

**Definition of done:**
- `GET /health` answers liveness + readiness (storage actually usable), fit
  for LB probes and a compose `healthcheck` (which must be **node-based** —
  `node:24-slim` has no curl/wget; verified).
- `GET /metrics` serves Prometheus text format covering the 0112 telemetry
  list plus HTTP and admission surfaces — **fail-closed**: unauthenticated
  only on loopback binds; non-loopback requires a bearer token (§3.2).
- Every log line the control plane emits goes through **one logger module**
  that **programmatically enforces** the redaction rules (field denylist +
  secret scrubber, §3.4) — including a new `request_failed` line with
  `requestId` on every 5xx (none exists today; `app.ts:285` `onError` is
  silent).
- Threat-model §5 updated from three "Open:" bullets to decided posture,
  with the persistence/log channel split made explicit (§3.4 R3).
- Docs: dev-deployment Observability section (endpoints, token setup,
  compose healthcheck, suggested alerts); README status updated.

**Non-goals (§8):** alerting/SLO tooling, per-workspace metering (Arc D),
OpenTelemetry/tracing, log shipping, console UI surfacing, persistence-layer
content redaction (deferred with rationale, §3.4 R3).

---

## 2. Current-state map (verified 2026-07-06, corrected by review)

- **Logging: 23 migratable `console.*` call sites.** The raw grep says 26
  but two are string literals (operator help text in `master-key.ts:31`,
  `admin/auth.ts:46`) and `main.ts:75` is first-boot **product output**
  (stdout UX, stays untouched, and the printed key must never pass through
  the logger). By file: `events/service.ts` **10**, `sessions/service.ts`
  8, `app.ts` 1 (auth-mode warning), `admin/routes.ts` 1 (`admin_audit`),
  `egress/utils/debug.ts` 2 + `egress-proxy-main.ts` 1. The egress pair is
  **OMA code, not vendored** — `debug.ts` is the vendor *shim* whose own
  header invites swapping in OMA's logger; only `egress/vendor/*` is
  edit-protected (0117), and this plan does not touch it. Note the sidecar
  (`egress-proxy-main.ts`) is a separate process; the logger module must
  import cleanly there (it does — no control-plane deps).
- **`app.onError` (`app.ts:285-295`) logs nothing** — 5xx responses are
  invisible in logs today. `requestId` already flows end-to-end
  (`app.ts:186-188`, response header + context + error bodies) — the
  correlation plumbing exists, unused by logging.
- **Countable state — corrections:** the existing count statements are
  **workspace-scoped** (`sessions/store.ts:164-167` `countActive(workspaceId)`,
  `events/store.ts:276-279` `countPendingRuntimeTurns(workspaceId)`). There
  is **no global count**; C2 adds two unscoped `COUNT(*)` store methods. The
  `sessions` table has **no index on `archived_at`** (only
  `(workspace_id, id)` and `(workspace_id, agent_id, id)`, `store.ts:31-32`)
  — an unscoped active-count would scan all historical rows on every scrape,
  so C2 also adds a partial index (§3.2). `InFlightGauge`
  (`admission.ts:82-119`) keeps its total **private**; a `get total()`
  accessor is needed for the SSE gauge. The gauge instance is reachable from
  the deployment assembly (`app.ts:113,323`).
- **Turn lifecycle** (for outcome/duration metrics): closure happens at
  **three sites** in `events/service.ts` — `closeRuntimeTurn*` (~1674/1699,
  reason `completed`), `closePendingRuntimeTurnsForSession` (~807, reasons
  `archived`/`deleted`), `terminalizeAbandonedRuntimeTurn` (~1040, reason
  `terminalized`) — plus `interrupted`. No timestamp exists on
  `RuntimePrompt` (~93-99), so durations need new (small) state.
- **HTTP middleware ordering is safe for metrics** (verified against Hono's
  `compose()`): a first-registered middleware that awaits `next()` and reads
  `c.res.status` sees the final status for onError-handled, notFound, and
  bodyLimit-rejected responses alike — the context is mutated in place.
- **No `/health`, no `/metrics`, no metrics dependency.** `prom-client` is
  not dependency-free (`@opentelemetry/api`, `tdigest`) — decision in §3.2.
- **Route layout:** `/health` and `/metrics` collide with nothing
  (`isManagedAgentsRoute` `app.ts:661`, `isAdminRoute` `app.ts:674` are
  prefix allowlists).

---

## 3. Design

### 3.1 `GET /health`

- **Unauthenticated** (LB/compose probes can't send keys; the body carries
  no tenant data). Registered for all deployments. `cache-control: no-store`.
- Response `200` / `503`:

  ```json
  {
    "status": "ok",            // "ok" | "degraded"
    "version": "0.0.1",        // package.json, read import.meta.url-relative
    "uptime_seconds": 123,
    "checks": {
      "storage": { "status": "ok", "free_bytes": 123456789 },
      "runtime": { "status": "ok" }
    }
  }
  ```

- **Liveness = the process answered. Readiness = every check ok** (503 with
  the failing check named). Checks are cheap: one prepared `SELECT 1`
  (storage connectivity) and pending-turns readability (runtime). What this
  **does not prove** — documented, not papered over: `SELECT 1` shows the DB
  is readable, not writable; disk-full surfaces via `fs.statfs` free-bytes
  on the file-storage root, **reported but not gating 503** (a threshold
  would flap the single node and drive compose restart loops — the
  suggested-alerts doc covers alerting on it instead). In-memory mode
  reports `storage: {status:"ok", mode:"in-memory"}` rather than lying.
- Failure detail stays coarse (`"storage check failed"` — no stacks, no
  paths). The `version` field is deliberate disclosure on an unauth
  endpoint: accepted (OMA is open source; fingerprinting value ≈ nil) and
  documented.
- `package.json` version is read once via
  `fileURLToPath(new URL("../../package.json", import.meta.url))` +
  `readFileSync` — same pattern as `bundledConsoleRoot()` (`app.ts:502`),
  works in checkout and image.
- **Compose healthcheck (node-based — the image has no curl/wget):**

  ```yaml
  healthcheck:
    test: ["CMD", "node", "-e",
      "fetch('http://127.0.0.1:4180/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
    interval: 15s
    timeout: 5s
    retries: 3
  ```

### 3.2 `GET /metrics` — fail-closed exposure, hand-rolled registry

**Exposure posture (review-corrected; the previous draft's default-open
argument was invalid — the 0120 gate covers credentials in transit, not
info disclosure, and Prometheus natively supports bearer auth):**

| Bind | `OMA_METRICS_TOKEN` unset | `OMA_METRICS_TOKEN` set |
| --- | --- | --- |
| loopback (default) | enabled, unauthenticated | enabled, `Authorization: Bearer` required |
| non-loopback | **404 — fail closed** | enabled, `Authorization: Bearer` required |

- `OMA_METRICS=0` disables the endpoint everywhere (parse:
  `parseBooleanFlag(env.OMA_METRICS ?? "1", "OMA_METRICS")` — the `?? "1"`
  is load-bearing; a bare parse would default the flag off, §9 Sonnet L6).
- The token is compared with the constant-time digest idiom from
  `admin/auth.ts`; Prometheus scrape config: `authorization: {credentials}`.
  The exposition is aggregate-only either way — the token gates *operational
  intelligence* (capacity, error rates, restart timing), not tenant data.
- Missing/wrong token → 401 with no body detail; non-loopback + no token →
  404 (endpoint absent, matching how unconfigured admin routes behave).

**Registry: hand-rolled, ~120 lines, zero deps — with the label-safety
property that makes this sound.** Every label value in the inventory below
is a **closed enum declared at metric registration**; the registry rejects
(buckets to `other`) any undeclared value at record time. Dynamic strings
can never become label values, so the exposition-escaping footgun
(prom-client's main correctness advantage) cannot occur by construction.
Opus preferred prom-client anyway (dissent recorded, §9 M1); the deciding
factors for hand-rolling: zero deps (`@opentelemetry/api` + `tdigest`, the
latter entirely unused), and a wire format that is small once labels are
enums. The insurance Opus demanded ships in §5: exposition is validated by
a strict text-format parser in tests (`# TYPE` lines, `+Inf` bucket,
`_sum`/`_count` presence and monotonic consistency, content-type
`text/plain; version=0.0.4`), plus a test that an undeclared label value
routes to `other` rather than into the exposition.

**Metric inventory (prefix `oma_`; all labels closed enums; no
workspace/session identifiers — per-tenant breakdowns are Arc D; adding any
label with tenant cardinality requires a plan amendment):**

| Metric | Type | Labels (closed sets) | Source |
| --- | --- | --- | --- |
| `oma_http_requests_total` | counter | `route_class` (v1/admin/console/health/metrics/other), `method` (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS/**other**), `status` | HTTP middleware |
| `oma_http_request_duration_seconds` | histogram | `route_class` | HTTP middleware |
| `oma_sessions_active` | gauge (scrape-time) | — | **new** unscoped count + partial index (below) |
| `oma_runtime_turns_pending` | gauge (scrape-time) | — | **new** unscoped count (`pending_runtime_turns` is bounded by in-flight work; no index needed) |
| `oma_runtime_turns_total` | counter | `outcome` — mapped from close reasons: `completed`→completed, `interrupted`→interrupted, `terminalized`→abandoned, `archived`/`deleted`→**not counted** (session lifecycle, not turn outcome) | the three close sites (§2) |
| `oma_runtime_turn_duration_seconds` | histogram | — | accept-time map (below), observed on `completed` only |
| `oma_admission_rejections_total` | counter | `limit` (sessions/turns/uploads/streams), `status` (429/529) | admission checks |
| `oma_sse_streams_active` | gauge | — | `InFlightGauge` + new `get total()` |
| `oma_sandboxes_total` | counter | `event` (created/disposed/reaped), `provider` (docker-local/microsandbox-local) | provider chokepoints (verified single-point, §2) |
| `oma_sandbox_provider_errors_total` | counter | `provider` | provider error paths |
| `oma_log_events_total` | counter | `level` | the logger |
| `oma_process_*` (rss/heap bytes, event-loop delay, uptime) | gauges | — | `process.memoryUsage()`, `perf_hooks.monitorEventLoopDelay` |

- **Sessions gauge**: new unscoped `COUNT(*) … WHERE archived_at IS NULL`
  statement **plus** partial index
  `CREATE INDEX idx_sessions_live ON sessions(archived_at) WHERE archived_at IS NULL`
  so the scan is O(active), not O(history) (§9 Opus M3 / Sonnet). Chosen
  over an in-memory gauge because counters drift across crash/recovery
  paths; the DB is the truth.
- **Turn durations**: a `Map<turnId, acceptedAtMs>` populated where the
  prompt is accepted, read+deleted at the close sites — small new state,
  honestly labeled as such (the earlier "no new plumbing" claim was wrong,
  §9 Sonnet M4). Entries for turns closed by session archive/delete are
  dropped without observation; the map cannot grow unbounded because every
  close path deletes.
- Histogram buckets: HTTP `[0.005, 0.02, 0.1, 0.5, 2, 10]`s; runtime turns
  `[0.25, 1, 5, 15, 60, 300, 900, 1800, 3600]`s — extends past the 15-min
  idle TTL so TTL-adjacent turns don't vanish into `+Inf` (§9 Opus).

### 3.3 Structured logger (small, not a framework)

One module, `src/control-plane/logging.ts` (~100 lines with redaction):

```ts
log.info("runtime_turn_completed", { sessionId, durationMs });
log.warn("snapshot_sweep_failed", { error });
log.error("request_failed", { requestId, routeClass: "v1", status: 500, error });
```

- One JSON line to stdout/stderr:
  `{"ts":"…","level":"…","event":"…", ...fields}`. `event` is snake_case,
  greppable, feeds `oma_log_events_total`.
- **The logger enforces redaction — it is not a convention** (§3.4):
  - **Field denylist**: any field whose key matches
    `message|text|prompt|content|input|output|body|authorization` or the
    heuristic `*key*|*secret*|*token*|*password*` is replaced with
    `"[redacted]"` before serialization. (Identifiers like `sessionId` pass;
    `apiKey` does not.)
  - **Error serialization**: `error` values become `{name, message}` where
    `message` first passes a **secret scrubber** — masks `oma_[A-Za-z0-9_-]+`
    tokens, 32-byte-base64-shaped strings, and `(x-api-key|x-admin-key|authorization)\s*[:=]\s*\S+`
    values — then a 1 KB cap. No stacks unless `OMA_LOG_STACKS=1`.
  - The cap bounds volume; the scrubber + denylist bound *content* — both
    are tested by asserting planted secrets/prompts are **absent**, not
    merely truncated (§5; the earlier cap-only test would have blessed the
    leak, §9 Codex-adv).
- Level filter `OMA_LOG_LEVEL` (default `info`; `debug` gates the two
  existing `console.debug` sites). No transports, rotation, or child
  loggers — stdout JSON is the contract.
- **New line required by DoD**: `request_failed` in `app.onError` with
  `requestId`, `routeClass`, `status`, and the (scrubbed) error — today's
  5xxes are silent (§9 Opus H3). HTTP metrics middleware and this log line
  share the route-class mapping.
- Migrate the 23 sites (§2); `admin_audit` keeps its wire shape (existing
  `type: "admin_audit"` field preserved; emitted through the logger).
- `main.ts` first-boot output stays plain stdout product UX; the printed
  key never passes through the logger.

### 3.4 Redaction posture (threat-model §5, decided)

**R1 — logs carry identifiers and classifications, never content or
credentials** — enforced by the logger's denylist, not by review-time
convention. Allowed: ids, event names, counts, durations, providers, status
codes, scrubbed error `{name, message}`.

**R2 — error messages are the leak channel; they are scrubbed, capped, and
tested for absence of planted content.** Provider/tool errors can embed
user content or secrets; the scrubber + denylist are the mitigation, and
the migration audits each site so no call wraps raw tool output wholesale.
Residual risk stated honestly: a scrubber is pattern-based — novel secret
formats can pass. The trusted-operator scope (below) bounds the blast
radius; sites that handle known-sensitive material must log classifications
instead of messages.

**R3 — persistence-layer content redaction is deferred — scoped, not
dodged.** Threat-model §5 floats regex redaction over event `text` blocks
before SQLite insert. Decision: **no**, for the single-node
trusted-operator deployment this appliance is (0112 tiers): transcripts are
the product; scrubbing them breaks replay and wire parity. Two things are
named explicitly rather than papered over (§9 Opus M2): (a) the
**asymmetry** — 0118 encrypts secrets at rest, yet a secret *echoed into
session content* (e.g. a tool printing an env var) persists in cleartext
SQLite; (b) this is the same residual as **ADR-0016 §6's** deferred
response-redaction item (an allowlisted upstream reflecting an injected
credential back into the sandbox), and both revisit together when the
deployment tier changes (managed/multi-tenant). §5's bullets split cleanly:
the **log channel** is closed by R1/R2; the **persist/stream channel** is
deliberately verbatim under R3 with the above recorded.

### 3.5 Wiring

- `src/control-plane/logging.ts` — logger + redaction (C1).
- `src/control-plane/observability/metrics.ts` — registry + collectors;
  `observability/routes.ts` — `/health` + `/metrics` (C2).
- `createControlPlaneApp` gains `observability?: {...}` (same optional-
  service idiom as `console`); metrics middleware registers **first**
  (sees final statuses — verified, §2); endpoints register before
  `notFound`. Deployment assembly wires checks, token, and scrape-time
  collectors; in-memory test assemblies pass nothing and see no change.
- Instrumentation: admission rejections at the existing check sites; turn
  outcomes at the three close sites + accept-time map; sandbox counters at
  the verified provider chokepoints; SSE gauge via `get total()`.
- compose healthcheck stanza (§3.1). Store changes: two unscoped COUNT
  statements + the partial index (schema migration follows the existing
  store-init pattern).

---

## 4. Security notes

- `/health` (always) and `/metrics` (loopback or token) are the appliance's
  first deliberately unauthenticated/optionally-authenticated endpoints.
  Neither may carry tenant data, key material, paths, or stacks; `/metrics`
  labels are closed enums enumerated in §3.2 — tenant-cardinality labels
  require a plan amendment.
- Both endpoints send `cache-control: no-store`.
- `OMA_METRICS_TOKEN` is compared constant-time (digest idiom from
  `admin/auth.ts`); it is a read-only operational credential, strictly
  weaker than the admin key — do not reuse the admin key as the metrics
  token (docs say so).
- The logger is a real chokepoint: denylist + scrubber run on every
  emission, tested for absence.

---

## 5. Tests

**C1 (logger):** JSON shape; level filtering; **redaction**: planted
`oma_…` key in an error message → absent from output; planted prompt text
in a denylisted field → `[redacted]`; oversized message → capped; stacks
absent by default / present with `OMA_LOG_STACKS=1`; `admin_audit` wire
shape unchanged (existing admin tests keep passing).

**C2 (endpoints + metrics):**
- Health: 200 + shape on durable boot; storage check → 503 when the DB is
  broken; in-memory reports `mode: "in-memory"`; no-store; unauthenticated
  with auth enabled; version present.
- Metrics exposure matrix: loopback/no-token → 200; non-loopback/no-token →
  404; token set → 401 without / 200 with correct Bearer (constant-time
  digest); `OMA_METRICS=0` → 404 everywhere; unset flag defaults ON
  (polarity test — §9 Sonnet L6); unknown flag value refuses boot.
- Exposition: parsed by a **strict text-format parser** (TYPE lines, `+Inf`
  bucket, `_sum`/`_count` present and consistent, content-type header);
  `oma_http_requests_total` increments with correct route_class/status for
  a 200, a 404, a bodyLimit 413, and an onError 500 (proves middleware
  placement); undeclared label value → `other`, exposition stays parseable;
  **mutation-check** the histogram bucket accounting.
- Gauges: created session / pending turn reflected at scrape (existing test
  harness); partial index exists (schema assertion); admission rejection
  increments on a 429 (reuse 0113 setup); SSE gauge total.
- `request_failed` log line emitted on a 5xx with `requestId` matching the
  response header.
- Route non-collision extended: `/v1`, `/admin`, `/console` unchanged.
- Container smoke: extend `scratch/41` — `/health` 200 from the built
  image, and the compose healthcheck command (node-fetch form) exits 0
  against it.

---

## 6. Docs

- dev-deployment "Observability": `/health` semantics (liveness vs
  readiness, what readiness does NOT prove — writability/disk; restart-loop
  note for compose), `/metrics` exposure matrix + Prometheus scrape snippet
  with `authorization.credentials`, `OMA_METRICS`, `OMA_METRICS_TOKEN`,
  `OMA_LOG_LEVEL`, `OMA_LOG_STACKS`, suggested-alerts table (error-log
  rate, pending-turns growth, 5xx rate, admission rejections, event-loop
  delay, storage free-bytes).
- README: appliance reports its own health; "still missing" loses
  observability.
- Threat-model §5 rewritten per §3.4 (with the ADR-0016 §6 cross-reference
  and the cleartext-persistence asymmetry named); 0112 gate row updated.
- Roadmap 0114 Arc C marked with outcome.

---

## 7. Settled / open

**Settled (was §7 open, resolved by review):** metrics exposure is
fail-closed per the §3.2 matrix (the default-open draft posture is dead —
its two supporting arguments were shown invalid); turn buckets extend to
3600s; minimal health shape (no RFC health+json).

**Open (mechanics only):**
1. Whether the metrics token env var also allows a `_FILE` variant like the
   other secrets (lean yes, trivial).
2. Exact scrubber pattern set — the three in §3.3 are the floor; extend
   during C1 if the site audit finds more shapes.

---

## 8. Non-goals / follow-ups

- Alerting/SLO tooling, dashboards (metric names + suggested alerts only).
- Per-workspace metering, `usage` population — **Arc D**, on these counters.
- OpenTelemetry, log shipping, rotation.
- Console UI health widget — later console polish slice (this ships the API
  it needs).
- Multi-process metric aggregation — single-node scope (0113/0114).
- Persistence-layer redaction — R3, revisits with the deployment tier.

---

## 9. Review disposition log (2026-07-06)

Pre-implementation review by Codex (review + adversarial), Opus, Sonnet.
Two draft positions were overturned; the factual base was corrected in six
places; one dissent is recorded.

- **Metrics default-open (Codex-adv HIGH, Opus H1) — ACCEPTED, redesigned.**
  Draft argued default-on-unauth via (a) tenant-anonymity, (b) "Prometheus
  can't send auth", (c) the 0120 transport gate as prior consent. (b) is
  false (`authorization.credentials` is native) and (c) is invalid (0120
  gates credentials in transit, not info disclosure). New posture: §3.2
  matrix — loopback open, non-loopback 404 unless `OMA_METRICS_TOKEN`
  (Bearer, constant-time).
- **`error.message` as leak channel (Codex-adv HIGH, Codex P1, Opus H2) —
  ACCEPTED.** Cap-only was volume control masquerading as redaction, and
  the draft's test would have blessed the leak. Now: field denylist +
  secret scrubber in the logger (a programmatic chokepoint, not a review
  convention), absence-based tests.
- **Missing 5xx log (Opus H3) — ACCEPTED**: `request_failed` + `requestId`
  in `onError` (verified silent today).
- **Method label cardinality (Codex P2) — ACCEPTED**: closed method enum +
  `other`; generalized — ALL labels are closed enums validated at record
  time.
- **prom-client vs hand-rolled (Opus M1) — PARTIALLY ACCEPTED, dissent
  recorded.** Opus leaned prom-client (otel-api is interface-only; tdigest
  unused; exposition escaping is the footgun). Held hand-rolled because the
  closed-enum label rule removes the escaping surface by construction;
  adopted Opus's insurance in full (strict exposition parser, `+Inf`/
  `_sum`/`_count`/content-type tests, hostile-value routing test). If the
  registry exceeds ~150 lines or needs a fourth metric shape, switch.
- **R3 dodge (Opus M2) — ACCEPTED**: rewritten with trusted-operator
  scoping, the 0118 cleartext asymmetry named, ADR-0016 §6 cross-ref, and
  the channel split (log vs persist) made explicit.
- **Factual corrections (Sonnet HIGH×2, MEDIUM×3, LOW×2; Opus M3) — ALL
  ACCEPTED**: node-based compose healthcheck (no curl/wget in the image —
  verified empirically); counts are workspace-scoped → new unscoped
  statements + partial live-sessions index; `InFlightGauge.total` needs a
  getter; turn closure is three sites with an explicit reason→outcome
  mapping and durations need an accept-time map (new state, honestly
  labeled); 23 migratable sites not 26 (egress shim + sidecar entrypoint
  in-scope; `egress/vendor/*` untouched); `OMA_METRICS` parse polarity
  (`?? "1"`); package.json version via import.meta.url-relative read.
- **Slice split (Opus M4) — ACCEPTED**: C1 (logger/redaction/threat-model)
  and C2 (endpoints/registry/instrumentation) as stacked PRs; requestId
  threading into HTTP logs made explicit.
- **Health-check honesty (Opus LOW) — ACCEPTED**: readable≠writable
  documented; statfs free-bytes reported-not-gating; restart-loop note;
  `version` disclosure accepted and documented.
- **Buckets (Opus §7-Q2) — ACCEPTED**: turns extended `…900, 1800, 3600` +
  sub-second `0.25`.
