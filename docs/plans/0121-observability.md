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

---

## 1. Why this slice exists / definition of done

Today the appliance emits ad-hoc `console.warn/error` lines (26 sites) and
one structured JSON event (`admin_audit`, `admin/routes.ts:68`). There is no
health endpoint (a load balancer or `docker compose` healthcheck has nothing
to probe), no metrics, and no stated rule about what may appear in a log
line. 0112 names the required telemetry: **runtime turns, pending waits,
sandbox lifecycle, provider errors, reaper activity.**

**Definition of done:**
- `GET /health` answers liveness + readiness (storage actually usable), fit
  for LB probes and a compose `healthcheck`.
- `GET /metrics` serves Prometheus text format covering the 0112 telemetry
  list plus HTTP and admission surfaces; scrapeable by a vanilla Prometheus.
- Every log line the control plane emits is a **structured JSON line** with
  a level and event name, through one tiny logger module — and the
  **redaction rule** (below) is written down, applied to all 26 sites, and
  enforceable in review.
- Threat-model §5 updated from three "Open:" bullets to decided posture.
- Docs: dev-deployment gains an Observability section (endpoints, compose
  healthcheck, suggested alerts); README status updated.

**Non-goals (§8):** alerting/SLO tooling (operator's Prometheus does that —
we ship metrics + a suggested-alerts table), per-workspace usage metering
(Arc D), OpenTelemetry/tracing, log shipping, console UI surfacing beyond
what exists, persistence-layer content redaction (deferred with rationale,
§3.4).

---

## 2. Current-state map (verified 2026-07-06)

- **Logging:** 26 `console.*` call sites outside tests. The busy ones are
  `events/service.ts` (runtime ingestion/recovery/lease errors, 8 sites) and
  `sessions/service.ts` (sweeps/cleanup warnings, 8 sites); the rest are
  boot-time warnings (`app.ts:140` auth-mode warning, master-key/admin-key
  loaders) and `main.ts` operator output (first-boot key — **stdout product
  output, not logging; stays untouched**). All current sites log identifiers
  and error objects, not message/tool content — the redaction rule mostly
  codifies existing practice.
- **`admin_audit`** (`admin/routes.ts:56-75`): already a structured JSON
  line via `console.info(JSON.stringify({type:"admin_audit",...}))` — the
  shape the logger generalizes.
- **Countable state already exists:** `InFlightGauge` per-workspace
  admission gauges (`admission.ts:82`); `SELECT COUNT(*)` queries for active
  sessions (`sessions/store.ts:165`), pending runtime turns
  (`events/store.ts:277`), events, API keys. The event store can answer
  "pending turns right now" cheaply — a natural readiness/metrics input.
- **No `/health`, no `/metrics`, no metrics dependency.** `prom-client` is
  NOT dependency-free (`@opentelemetry/api`, `tdigest`) — see §3.2.
- **Route layout:** `/v1/*` (workspace auth), `/admin/*` (admin auth),
  `/console/*` (static). `/health` and `/metrics` collide with nothing;
  `isManagedAgentsRoute`/`isAdminRoute` ignore them.

---

## 3. Design

### 3.1 `GET /health`

- **Unauthenticated** (LB/compose probes can't send keys; the body carries
  no secrets and no tenant data). Registered for all deployments.
- Response `200` / `503` with `cache-control: no-store`:

  ```json
  {
    "status": "ok",            // "ok" | "degraded"
    "version": "0.0.1",        // package.json version
    "uptime_seconds": 123,
    "checks": {
      "storage": { "status": "ok" },   // durable mode: SELECT 1 on the DB
      "runtime": { "status": "ok" }    // runner constructed; pending turns readable
    }
  }
  ```

- **Liveness = the process answered.** **Readiness = every check ok** (503
  with the failing check named otherwise). Checks must be cheap (one
  prepared `SELECT 1`, no filesystem walks) — a probe every 5s must not
  matter. In-memory mode reports `storage: {status:"ok", mode:"in-memory"}`
  rather than lying about durability.
- Failure detail stays coarse (`"error": "storage check failed"` — no stack
  traces, no paths) since the endpoint is unauthenticated.

### 3.2 `GET /metrics` — hand-rolled minimal registry, not prom-client

`prom-client` drags in `@opentelemetry/api` + `tdigest`; we need counters,
gauges, and two histograms in a text format that is trivial to emit. A
**small registry module (~120 lines)** keeps the dependency footprint at
zero, matching the vendored-egress precedent. Cost of hand-rolling: no free
default process metrics — we emit the few that matter by hand
(`process.memoryUsage()`, `monitorEventLoopDelay` from `node:perf_hooks`,
uptime). Histogram = fixed buckets, counts + sum (the standard exposition);
no quantile estimation (that is what tdigest was for; buckets suffice).

**Metric inventory (prefix `oma_`, aggregate-only — no workspace/session-id
labels; per-tenant breakdowns are Arc D metering, and unlabeled aggregates
keep the endpoint tenant-anonymous):**

| Metric | Type | Labels | Source |
| --- | --- | --- | --- |
| `oma_http_requests_total` | counter | `route_class` (v1/admin/console/health/metrics/other), `method`, `status` | HTTP middleware |
| `oma_http_request_duration_seconds` | histogram | `route_class` | HTTP middleware |
| `oma_sessions_active` | gauge (collected at scrape) | — | `sessions/store.ts:165` count |
| `oma_runtime_turns_pending` | gauge (collected at scrape) | — | `events/store.ts:277` count |
| `oma_runtime_turns_total` | counter | `outcome` (completed/failed/interrupted/recovered) | events service ingestion/recovery paths |
| `oma_runtime_turn_duration_seconds` | histogram | — | events service |
| `oma_admission_rejections_total` | counter | `limit` (sessions/turns/uploads/streams), `status` (429/529) | admission checks |
| `oma_sse_streams_active` | gauge | — | existing `InFlightGauge` |
| `oma_sandboxes_total` | counter | `event` (created/disposed/reaped), `provider` | docker/microsandbox lifecycle |
| `oma_sandbox_provider_errors_total` | counter | `provider` | provider error paths |
| `oma_log_events_total` | counter | `level` | the logger itself (cheap alerting hook: rate of `error`) |
| `oma_process_*` (rss bytes, heap bytes, event-loop delay p~max, uptime) | gauges | — | process |

Two collection styles, both simple: **incremented at the call site** (via
the metrics module) for counters/histograms, and **collected at scrape
time** for the two DB-count gauges (one prepared statement each — no
background sampling loop to babysit).

**Auth posture:** `/metrics` is **enabled by default, unauthenticated**, like
`/health`. Rationale: (a) the exposition is aggregate-only and
tenant-anonymous by design; (b) vanilla Prometheus cannot send an
`x-admin-key` header, and inventing a second bearer path is scope creep; (c)
the appliance's default bind is loopback, and any non-loopback deployment
already went through the 0120 transport gate decision consciously. Escape
hatch: `OMA_METRICS=0` disables the endpoint (parsed with the strict boolean
idiom). This is a deliberate, documented softness — flag in review if it
should be stricter.

### 3.3 Structured logger (small, not a framework)

One module, `src/control-plane/logging.ts` (~60 lines):

```ts
log.info("runtime_turn_completed", { sessionId, durationMs });
log.warn("snapshot_sweep_failed", { error });   // error -> {name, message}
log.error("runtime_ingestion_failed", { sessionId, error });
```

- Emits one JSON line to stdout/stderr:
  `{"ts":"…","level":"warn","event":"snapshot_sweep_failed","sessionId":"…","error":{"name":"…","message":"…"}}`.
- `event` is a snake_case identifier, never prose — greppable, countable
  (feeds `oma_log_events_total`).
- **Error serialization is the redaction chokepoint**: `{name, message}`
  only — no stack in production output (`OMA_LOG_STACKS=1` opts in for
  debugging), message capped (1 KB) so an error that embeds a giant tool
  output cannot flood the log.
- Level filter via `OMA_LOG_LEVEL` (default `info`; `debug` gates the two
  existing `console.debug` sites). No transports, no rotation, no child
  loggers — stdout JSON is the whole product; the operator's collector does
  the rest.
- Migrate all 26 sites; `admin_audit` keeps its wire shape (emitted through
  the logger with `event: "admin_audit"` and its existing fields — the
  0119-documented `type` field is preserved for compatibility).
- `main.ts` first-boot/operator output remains plain `log()` lines to
  stdout — that is product UX, not telemetry, and the printed key must NOT
  pass through the logger (rule below).

### 3.4 Redaction posture (threat-model §5, decided)

**Rule R1 — logs carry identifiers and classifications, never content or
credentials.** Allowed fields: ids (session/workspace/agent/event/request),
event names, counts, durations, providers, status codes, error
`{name, message(capped)}`. Forbidden: message/prompt text, tool
inputs/outputs, file contents, any key/plaintext/secret value, `Authorization`
/`x-api-key`/`x-admin-key` header values. The first-boot key prints to
stdout as product output, bypassing the logger by design.

**R2 — error messages are the leak channel to watch.** Provider/tool errors
can embed user content (threat model §5 bullet 3). Mitigations: the logger's
message cap + no stacks by default; implementation audits each migrated site
so no `error` object wraps raw tool output wholesale.

**R3 — persistence-layer content redaction is deferred, with rationale.**
Threat-model §5 floats regex redaction over event `text` blocks before
SQLite insert. Decision: **no.** The appliance's job is to *store* session
transcripts durably for its operator — scrubbing them would break replay and
wire parity; the store is already the operator's own protected asset (0118
encrypts secrets at rest separately). §5 is updated to record this as a
decision, closing its "Open:" bullets: emission (logs) is redacted by R1/R2;
persistence (events) is deliberately verbatim.

### 3.5 Wiring

- `src/control-plane/observability/metrics.ts` — registry (counter/gauge/
  histogram + text exposition) and the process/scrape-time collectors.
  `src/control-plane/observability/routes.ts` — `/health` + `/metrics`
  handlers. `src/control-plane/logging.ts` — the logger.
- `createControlPlaneApp` gains `observability?: { health: HealthChecks;
  metrics?: MetricsRegistry }` (same optional-service idiom as `console`);
  HTTP middleware for request metrics registers first, endpoints register
  before `notFound`. The deployment assembly wires storage/runtime checks
  and the scrape-time collectors; in-memory test assemblies pass nothing and
  see no behavior change.
- Instrumentation touch points: admission checks (rejection counters),
  events service (turn outcomes/durations — at the existing
  ingestion/recovery seams, not new plumbing), docker/microsandbox providers
  (lifecycle/error counters), SSE gauge reuse.
- `docker-compose.yml` gains a `healthcheck` stanza hitting `/health`;
  Dockerfile `HEALTHCHECK` optional (compose is the documented path).

---

## 4. Security notes

- `/health` and `/metrics` are the appliance's first **deliberately
  unauthenticated** endpoints. Both must never carry tenant data, key
  material, paths, or stack traces; `/metrics` labels are enumerated in this
  plan and adding a label with tenant cardinality requires a plan amendment.
- Both endpoints send `cache-control: no-store`.
- The transport-gate reasoning (0120) is unchanged: these endpoints carry no
  credentials in either direction.
- The logger is the redaction chokepoint — R1/R2 are testable at review
  time because every emission goes through one module.

---

## 5. Tests

- **Health:** 200 + shape on healthy durable boot; `storage` check flips to
  503 when the DB is closed/broken (construct, close store, probe);
  in-memory mode reports `mode: "in-memory"`; no-store header; unauthenticated
  access with auth enabled.
- **Metrics:** exposition parses (counter/gauge/histogram lines well-formed);
  `oma_http_requests_total` increments for a labeled route class; scrape-time
  gauges reflect a created session / pending turn (drive via existing test
  harness); admission rejection increments on a 429 path (reuse 0113 test
  setup); `OMA_METRICS=0` → 404; unknown flag value refuses boot (house
  idiom); **mutation-check**: break the histogram bucket accounting and the
  exposition test must fail.
- **Logger:** JSON shape; level filtering; error serialization (no stack by
  default, cap applied); a **redaction unit test** feeding an error whose
  message embeds a fake secret/oversized tool output and asserting the cap.
- **Route non-collision:** `/v1`, `/admin`, `/console` behavior unchanged
  with observability wired (extend the existing shadowing test).
- Container smoke: extend `scratch/41` (or a sibling) to assert `/health`
  200 from the built image — the compose healthcheck depends on it.

---

## 6. Docs

- dev-deployment: "Observability" section — `/health` semantics (liveness vs
  readiness), `/metrics` + Prometheus scrape snippet, `OMA_METRICS`,
  `OMA_LOG_LEVEL`/`OMA_LOG_STACKS`, suggested alerts table (error-log rate,
  pending-turns growth, 5xx rate, admission rejections, event-loop delay).
- README: status bullet (appliance reports its own health); "still missing"
  loses observability, keeps metering.
- Threat model §5 rewritten per §3.4; 0112 gate table row updated.
- Roadmap 0114 Arc C marked with outcome.

---

## 7. Open questions (decide in review)

1. **`/metrics` default-on unauthenticated** (§3.2) — is the documented
   softness acceptable, or should default be `OMA_METRICS=0` (fail-closed
   flavor) at the cost of every operator flipping it on?
2. **Histogram buckets** — proposal: HTTP `[0.005,0.02,0.1,0.5,2,10]`s,
   runtime turns `[1,5,15,60,300,900]`s. Sanity-check the turn buckets.
3. **`/health` shape** — any value in mirroring a known convention (e.g.
   RFC-draft health+json `status: pass/fail`) over the minimal shape above?

---

## 8. Non-goals / follow-ups

- Alerting/SLO tooling, dashboards (ship metric names + suggested alerts;
  operator's stack does the rest).
- Per-workspace metering and `usage` population — **Arc D**, which will
  build on these same counters.
- OpenTelemetry traces/spans, log shipping, rotation — out; stdout JSON is
  the contract.
- Console UI health widget — candidate for a later console polish slice
  (roadmap says "surfaced in the console"; the API surface this slice ships
  is the prerequisite).
- Multi-process metric aggregation — single-node appliance scope only,
  consistent with 0113/0114.
