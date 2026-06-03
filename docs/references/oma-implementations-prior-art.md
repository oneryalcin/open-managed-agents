# OMA implementations prior art: open-ma / openma.dev

Date: 2026-06-03

Purpose: survey the most complete competing open-source Managed Agents
implementation, `open-ma/open-managed-agents`, against our architecture and the
slices we have shipped. This extends the clone survey already started in
[file-storage-prior-art.md](file-storage-prior-art.md) (which covered
`rogeriochaves/open-managed-agents` and OpenClaw Managed Agents) to the largest
and most productized clone we have found.

This is not an ADR. It records where a much broader implementation validates,
challenges, or simply diverges from our decisions, and what (if anything) we
should borrow.

Note on naming: this project shares our name (`open-managed-agents`) and goal
(open-source Claude Managed Agents parity) but is an independent codebase under
the `open-ma` org, not a fork of ours and not our upstream. Different stack top
to bottom.

## Scope

Reviewed for:

1. overall architecture and deployment model,
2. agent execution engine,
3. sandbox / tool execution,
4. persistence and event-log ordering,
5. Managed Agents API surface coverage, including the hard problems we have been
   building (durable runtime turns, observability spans, session output files,
   tool confirmations, custom tools),
6. productization surface (auth, multi-tenancy, billing, integrations),
7. what to borrow vs what not to copy.

Sources checked:

- Local clone at `/tmp/open-ma-compare`, pinned to `f72a33f`
  (`[codex] add managed agent dreams (#115)`).
  - `package.json`, `README.md`
  - `ORDERING_DESIGN.md`, `DUAL_TABLE_DESIGN.md` (repo root)
  - `apps/agent/src/harness/default-loop.ts`, `apps/agent/src/harness/tools.ts`,
    `apps/agent/src/runtime/sandbox.ts`, `apps/agent/src/session-do.ts`
  - `apps/main/src/index.ts`, `apps/main/src/routes/files.ts`,
    `apps/main/src/auth-config.ts`
  - `apps/main-node/` (Node self-host entry)
  - `packages/session-runtime/src/machine.ts`,
    `packages/session-runtime/src/recovery.ts`
  - `packages/sandbox/src/ports.ts` and adapters
  - `packages/event-log/src/`, `packages/api-types/src/types.ts`
  - `packages/db-schema/`, the five `drizzle.*.config.ts` files
  - `packages/http-routes/src/sessions/index.ts`
- Marketing/engineering blog: https://openma.dev/blog/ (index read
  2026-06-03; eight posts).

## Verdict

No correction required to our architecture or shipped slices. On the core
wire-compatible surface (sessions, append-only event log + SSE replay,
`session.status_*` lifecycle, tool confirmations, custom tools, model-request
spans, session output files, durable runtime turns with fencing/recovery) we are
at rough feature parity, reached independently. They are far ahead on
productization (auth, multi-tenancy, billing, integrations, console UI, edge
deploy, docs/marketing). We appear ahead on per-feature correctness rigor for the
narrow surface we have shipped.

The single most useful idea to take from them is the **dual-table event log**
(separate `pending_events` queue, `seq` assigned at drain) as the canonical
answer to "a user message arriving mid-turn must not reorder `ORDER BY seq`."
We solved an adjacent problem differently; their write-up is worth reading before
we touch event ordering again.

Two things explicitly **not** to copy: their model-agnostic hand-rolled agent
loop (we deliberately delegate to the Pi coding-agent SDK per ADR 0001), and
their Cloudflare-Durable-Object-first deployment bet (our target is
Node/Docker/Modal/K8s).

## Findings by dimension

### Architecture and deployment

Shape: a pnpm monorepo — 52 packages (`packages/*`) and 8 apps (`apps/*`),
~783 TypeScript source files. Primary target is Cloudflare Workers + Durable
Objects + Containers; Node self-host (`apps/main-node`, `docker compose up`) is a
port of the same shared logic. Storage is D1 + KV + R2 on CF, SQLite/Postgres +
local FS on Node. The bet is **one Durable Object per session** as the unit of
isolation: each `SessionDO` holds its own embedded SQLite event log, an attached
Container sandbox, and R2 for blobs/workspace snapshots.

OMA implications:

- Validates our pluggable-boundary instinct (ADR 0003): every storage/execution
  concern sits behind a port so the same route handlers run on two very different
  substrates. Our single-package Node shape is the right scope for our target;
  their monorepo is the cost of supporting edge + self-host + a product.
- Their "thin shell" goal is unmet: `apps/agent/src/session-do.ts` is ~5,854
  lines, i.e. the CF runtime is still highly concentrated in one bespoke file.
  This is a caution about deferring the platform-adapter unification — the thing
  our ADR 0003 boundary is meant to prevent.

What not to copy:

- The Cloudflare-DO-first model. Durable Objects give them strong per-session
  single-writer serialization "for free," but they are a CF-specific primitive.
  Our owner-fencing / lease model achieves the equivalent invariant without
  binding us to an edge runtime.

### Agent execution engine

Mechanism: a hand-rolled loop on the **Vercel AI SDK** (`ai` + `@ai-sdk/anthropic`),
in `apps/agent/src/harness/default-loop.ts` (`streamText` with
`stepCountIs(maxSteps)`). `provider.ts` resolves Anthropic, OpenAI, and
`*-compatible` proxies, so the same harness is model-agnostic by construction.
No embedded coding-agent SDK; no shell to Claude Code.

OMA implications:

- This is the deepest divergence from us. ADR 0001 chose to embed the Pi
  coding-agent SDK as the engine rather than own the loop. Their approach buys
  model-agnosticism and full control of the step loop; ours buys far less
  surface to maintain and a purpose-built coding agent, at the cost of inheriting
  Pi's behavior (which is exactly why our "probe-then-trust" discipline exists).
- Their model-agnostic provider layer is a genuine capability we do not have. If
  multi-provider support ever becomes a requirement, this is the reference shape
  — but it would mean re-opening ADR 0001, not a small change.

What not to copy:

- Do not hand-roll the loop to chase model-agnosticism unless ADR 0001 is being
  revisited deliberately. The loop is where most agent-runtime bugs live; we
  chose to not own it.

### Sandbox / tool execution

Port: `SandboxExecutor` (`packages/sandbox/src/ports.ts`). Adapters: Cloudflare
Sandbox / Containers (prod), plus `local-subprocess` (dev), `e2b` (Firecracker),
`daytona`, `boxrun`, `litebox`. Outbound credentials are injected by a separate
`oma-vault` Worker that proxies the container's HTTPS, so secrets never live in
the image.

OMA implications:

- Confirms ADR 0003's provider boundary and our `collectOutputFiles?` /
  `materializeFileResources?` optional-method pattern: a fleet of sandbox
  backends behind one interface is the proven shape.
- The vault-proxy outbound-credential-injection pattern is a clean idea worth
  noting for whenever we design credential handling (we currently have none).

What not to copy:

- Their breadth of sandbox adapters (5+) is product scope, not core-clone scope.
  Docker-local remains the right single v1 target for us.

### Persistence and event-log ordering

Drizzle across five configs (`cf-auth`, `cf-router`, `cf-integrations`,
`node-pg`, `node-sqlite`). The control-plane data lives in D1/Postgres/SQLite;
the **session event log lives separately** in per-session DO-SQLite (or a
per-session better-sqlite3 file on Node), with large events spilled to R2.

Event ordering is the notable piece, documented in `ORDERING_DESIGN.md` and
`DUAL_TABLE_DESIGN.md`. The problem: a user message sent mid-turn, if it takes
`seq` at arrival time, lands in the middle of an agent turn and corrupts
`ORDER BY seq` on replay. Their fix (Candidate C) is a **dual-table** design:

- `pending_events` receives user-side inputs (`user.message`,
  `user.tool_confirmation`, `user.custom_tool_result`) at send time with a
  FIFO `pending_seq`;
- `events` is the canonical log; `seq` is assigned by AUTOINCREMENT **at drain
  time**, so `seq order = drain order = what the model actually saw`;
- drain is peek → INSERT into `events` (gets seq) → DELETE from `pending_events`,
  with `event_id` dedup so a crash between INSERT and DELETE degrades to a cheap
  "duplicate promote," never a lost message;
- three additive `system.*` SSE frames (`user_message_pending`,
  `user_message_promoted`, `user_message_cancelled`) that old SDK consumers
  ignore.

OMA implications:

- This is the headline borrow. Our `events` table is session-scoped append-only
  with no `turn_id`; we keep durable-turn machinery in a separate
  `pending_runtime_turns` table (see
  [0013-0014-0051-durable-runtime-and-storage.md](../plans/0013-0014-0051-durable-runtime-and-storage.md)).
  Their `pending_events` queue solves the specific "mid-turn user input
  reordering" hazard cleanly and additively. Read `ORDERING_DESIGN.md` before we
  next touch event ordering or interrupt handling.
- Their event-log-in-DO-SQLite (one log per session) is the DO analogue of our
  session-scoped log; the separation of control-plane store from event log
  matches our `events` vs the rest split.

What not to copy:

- Five Drizzle backends is multi-substrate product cost. Our single
  `node:sqlite` store is the right scope; the lesson is the *ordering* design,
  not the backend sprawl.

### Managed Agents API surface — head to head on the hard problems

They implement, to production depth, every area we have been building:

- **Durable runtime / recovery**: `turn_id` column on `sessions`,
  `beginTurn`/`endTurn` fencing, `SessionStateMachine.onWake` →
  `listOrphanTurns` → `recoverInterruptedState`, a 30s DO alarm re-arm while a
  turn is in flight, persistent `terminated` status, and a
  `crash-recovery.test.ts`. Our analogue is `owner_id`/`owner_generation`
  fencing + lease/claim + recovery (the #69 machinery). Same invariant, different
  primitive (their DO alarm vs our lease).
- **Observability spans**: `span.model_request_start` / `span.model_request_end`
  with `model_usage`, **plus** extensions we do not have:
  `span.model_first_token` (TTFT split) and `span.compaction_summarize_*`, and
  LLM call bodies persisted to R2 with a `GET /v1/sessions/:id/llm-calls/:event_id`
  retrieval route. Our span work (plan 0084 / #77) covers the start/end pair and
  permission-gated ordering; their first-token and compaction spans are a parity
  gap worth tracking if we extend observability.
- **Session output files**: `/mnt/session/outputs/` mapped to an R2 prefix;
  `GET /v1/files?scope_id=<sessionId>` synthesizes `out:<sessionId>:<b64(name)>`
  file records folded into the normal paginated Files response, plus
  `GET /v1/sessions/:id/outputs[/:filename]`. We implemented the same Files-API
  contract via a Docker tmpfs + `replaceSessionOutputs` with quota/collision/
  owner-gated indexing (plan 0090). Same wire contract, different storage path.
- **Tool confirmations**: ask-gated `requires_action` →
  `user.tool_confirmation`, implemented by stripping the tool's `execute` so the
  AI SDK returns a pending call. Equivalent to our permission flow.
- **Custom tools**: `agent.custom_tool_use` round-trip via
  `user.custom_tool_result`, with orphan-as-warning recovery. Equivalent to ours.

Their event type set (`packages/api-types/src/types.ts`, `SPEC_EVENT_TYPES`) is a
useful cross-check for our event-topology parity tracker
([managed-agents-event-topology.md](managed-agents-event-topology.md)): it
includes streaming chunk frames (`agent.message_chunk`,
`agent.message_stream_start/end`, thinking chunks), `agent.mcp_tool_use/result`,
thread events, and outcome-evaluation spans we have marked deferred.

OMA implications:

- Independent convergence on the same designs (durable turns, output-file Files
  API, span pairs, confirmations) is strong evidence our reading of the hosted
  contract is correct.
- Their `SPEC_EVENT_TYPES` is a second opinion on the full event vocabulary; diff
  it against our topology tracker to catch any frame we have mis-scoped.

### Productization surface

Fully built out and entirely absent from our scope: Better Auth (email/OTP/Google,
Turnstile) + SHA-256 API keys; multi-tenant D1 sharding (`tenant`/`membership`,
router DB, per-request tenant DB middleware); billing/quotas/rate-limits
(`USAGE_METER`, daily session caps, `cf-billing`); vaults (outbound credential
proxy); Linear/GitHub/Slack integrations; an evals framework; a "dreams"
pipeline; memory stores; MCP proxy; skills; a React Console UI; a CLI + local
"runtime" daemon that runs ACP agents (Claude Code/OpenCode) via a local bridge;
plus marketing site, docs site, and blog.

Caution signal: despite ~151 test files, the only GitHub Actions workflows are
`release.yml` and `build-sandbox-image.yml` — no visible CI test gate. Breadth
without an enforced test wall is a posture we should not emulate.

OMA implications:

- This is the gap between "faithful self-hostable core" (us) and "full SaaS
  platform" (them). None of the product layer is required for our stated goal,
  and most of it (billing, multi-tenant sharding, console) is out of scope per
  our roadmap.
- Their local-runtime/ACP-daemon idea (run an existing coding agent via a bridge
  instead of a cloud sandbox) is an interesting alternative to the embedded-SDK
  model; note it, do not chase it.

## Blog (openma.dev/blog) — what they publish

Eight posts, marketing + engineering, with visible SEO investment (recent commits
rebrand around "Claude Managed Agents alternative"):

- Migration guide: Claude Managed Agents → Open Managed Agents (client code,
  sessions, vaults, integrations).
- Architecture deep-dive: DO + embedded SQLite log, Containers sandbox, R2 blobs,
  "brain (harness) vs body (sandbox)" split.
- Cloudflare deploy guide (Workers + DO + Containers + R2; wrangler, secrets,
  domains).
- "What's shipping in 2026": honest comparison vs LangGraph / AutoGen / CrewAI,
  plus "what's still missing."
- Non-Cloudflare substitution guide.
- Claude Managed Agents vs Open Managed Agents: side-by-side (API surface,
  runtime, sandbox, billing).
- BYOK manifesto ("why an open-source meta-harness").

Takeaway: they are positioning as *the* open-source CMA alternative with a
product and a business model. Useful as a market signal and as a second source on
the hosted CMA contract; not a source of code patterns for us.

## Cross-cutting lessons

- The core CMA surface we are building (durable turns, spans, output files,
  confirmations, custom tools) is independently reproduced by the most complete
  competing clone. Treat that as confirmation, and use their `SPEC_EVENT_TYPES`
  and `ORDERING_DESIGN.md` as cross-checks, not as code to import.
- The one design idea worth genuinely studying is the dual-table pending-event
  queue for mid-turn ordering. Everything else is either a different substrate
  bet (CF/DO, Vercel AI SDK) or product scope (auth, billing, integrations).
- Breadth has a documented cost even for them (5.8k-line `session-do.ts`, no CI
  test gate). Our narrow-surface + high-rigor posture is a deliberate, defensible
  trade.

## Recommendation

No change to current plans or shipped slices.

Track as optional follow-ups (file as tickets if pursued):

- Read `ORDERING_DESIGN.md` / `DUAL_TABLE_DESIGN.md` before the next event-
  ordering or interrupt-handling change; evaluate a pending-queue split against
  our append-only `events` + `pending_runtime_turns` model.
- Diff their `SPEC_EVENT_TYPES` against
  [managed-agents-event-topology.md](managed-agents-event-topology.md) to catch
  any mis-scoped event frame (streaming chunks, MCP tool events, first-token /
  compaction spans).
- Note `span.model_first_token` and compaction spans as a known observability
  parity gap relative to hosted, if we extend span coverage beyond plan 0084.

Do not adopt: the Vercel-AI-SDK hand-rolled loop (would re-open ADR 0001), the
Cloudflare-DO-first deployment model, the multi-backend Drizzle sprawl, or any of
the product layer (auth/billing/multi-tenancy/integrations) without an explicit
scope decision.

---

## Appendix: verbatim comparison tables

Kept as-is for quick reference. Pinned to clone `f72a33f`, blog read 2026-06-03.

### Headline comparison

| Dimension | Ours | Theirs (open-ma / openma.dev) |
|---|---|---|
| Shape | Single-package Node app (`src/`) | Monorepo: 52 packages + 8 apps, ~783 TS files |
| Primary target | Node / Docker / Modal / K8s | Cloudflare Workers + Durable Objects + Containers; Node self-host is a port |
| Agent engine | Embeds `@earendil-works/pi-coding-agent` (a real coding-agent runtime) | Hand-rolled loop on Vercel AI SDK (`streamText`), model-agnostic (Anthropic/OpenAI/compatible) |
| Sandbox | Docker-local + InMemory + host-passthrough | CF Containers (prod) + E2B / Daytona / BoxRun / Litebox / LocalSubprocess |
| Persistence | `node:sqlite` (single `DatabaseSync`), in-memory file storage | Drizzle across 5 backends (D1 / Postgres / better-sqlite3); event log in per-session DO-SQLite, blobs in R2 |
| Event ordering | Session-scoped append-only `events` (no `turn_id`); durable turns in separate `pending_runtime_turns` | Dual-table `events` + `pending_events` — `seq` assigned at drain so `ORDER BY seq` = model-correct order |
| License / status | UNLICENSED, private, v0.0.1 | Apache-2.0, public, published `@openma/*`, v0.1.0, openma.dev |

### Hard-problems head-to-head

| Feature | Ours | Theirs |
|---|---|---|
| Durable runtime turns + fencing | `owner_id`/`owner_generation` + lease/claim + recovery | `turn_id` fencing + 30s DO alarm + `onWake` orphan recovery + crash-recovery tests |
| Observability spans | `span.model_request_start`/`_end`, durable open-id ledger | same, plus `span.model_first_token` (TTFT) + compaction spans + LLM bodies persisted to R2 |
| Session output files | Docker tmpfs → `replaceSessionOutputs`, quota/collision/owner-gated | R2 prefix → synthesized `out:` file ids folded into `GET /v1/files?scope_id=` |
| Tool confirmations | ask-gated `requires_action` → `user.tool_confirmation` | same (strips tool `execute` so AI SDK returns pending call) |
| Custom tools | `agent.custom_tool_use` round-trip | same |

### One-line characterization

Theirs: a Cloudflare-native, model-agnostic, fully productized SaaS platform
(auth, multi-tenancy, billing, integrations, console, edge deploy) built on a
Vercel-AI-SDK loop and Durable Objects. Ours: a lean, Pi-SDK-engined, Node-first
faithful clone of the core CMA wire surface, narrower but with higher per-feature
correctness rigor. Rough parity on the core session/event/files/spans/tools
surface; they are far ahead on productization; we are ahead on rigor for what we
ship.
