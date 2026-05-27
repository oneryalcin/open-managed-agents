# ADR 0008: Contract-test patterns — spec-first specs, alignment lints, CI smoke

**Status:** Accepted, 2026-05-21

## Context

We've already paid for the wire-contract drift bug class once — the `tool_use_id` vs `custom_tool_use_id` field-name mixup in [ADR 0005](0005-custom-tools-as-blocking-async-functions.md)'s pseudocode, caught in code review. The fix was free, but only because the code wasn't shipped. Once routes exist, the same drift produces broken clients in production.

This ADR adopts standard engineering practices that prevent — or fail loudly on — wire-contract drift. None of these patterns are novel; they're well-known hygiene for projects with multiple type/schema/runtime declarations of the same thing. Documented here so future contributors know which guard each test provides and which classes of drift remain unguarded.

## Patterns adopted

### 1. Spec-first executable backlog (`specs/*.feature`)

Standard Gherkin-style `.feature` files describing API behavior before routes are written. Acts as a forcing function — if you can't write the spec, you don't yet understand the feature. If the spec contradicts itself, the design is broken before code is wasted on it.

- Not yet executable in our project (no Cucumber runner); the specs serve as living docs the implementation must satisfy. Convert to executable form if/when it pays off.
- **Initial specs:** `specs/events-replay.feature`, `specs/custom-tool-roundtrip.feature`, `specs/sandbox-lifecycle.feature`.

### 2. Event-type alignment test (set-equality + format check)

Cross-reference the canonical wire-compatible event-type list against the declared `EventType` union. Catches additions/renames that update one side without the other.

- **v1 (current):** assert `EVENT_TYPES` (the runtime registry derived from the `EventType` union via `typeof[number]`) matches a hardcoded wire-compat list from ADR 0004 Tier 1, and every type follows the wire-format regex.
- **v2 (when routes land):** regex-scan our route handlers and Zod schemas for event-type literals, assert they all appear in `EVENT_TYPES`. The literal extraction catches "engine emits a type that's missing from the union" — the cancellation-branch drift class.
- **File:** `src/types/__tests__/events.test.ts`.

### 3. Schema-handler drift meta-lint

Iterate the fields of a request/response schema; assert each is referenced by the corresponding handler. Catches "schema accepts field X but handler silently ignores it."

- **Deferred:** No schemas or handlers yet. Add when we land Hono routes + Zod schemas.

### 4. Web/CLI API contract tests

Client tests stub `fetch` and verify method/path/body for every mutation.

- **Deferred:** No client SDK / CLI yet. Apply when we publish one.

### 5. CI smoke topology

CI does typecheck + tests + build + server-boot smoke (create agent/env/session, send event, list events, open SSE, reconnect).

- **Deferred:** Until first push to a remote.

## Prior art checked (2026-05-27)

`rogeriochaves/open-managed-agents@e9a0743` is a broader full-stack product, not a Pi-backed Managed Agents protocol clone, so do not copy its runtime architecture. It does validate several contract-hygiene patterns from this ADR:

- **BDD specs as the product backlog.** Its `AGENTS.md` requires discover → spec → implement → test → compare, and the repo carries many `specs/*.feature` files. This supports our decision to keep feature specs as design-pressure and acceptance artifacts even before they become fully executable.
- **Schema/type/event alignment lints.** Its server has meta-tests that regex-scan emitted event-type literals and compare them against declared TypeScript/Zod event unions (`packages/server/src/__tests__/event-type-alignment.test.ts:1`, `packages/server/src/__tests__/schemas-types-event-alignment.test.ts:1`). This is exactly ADR 0008's v2 direction once our route/schema surface grows.
- **What not to adopt.** Its event pagination uses `processed_at` cursors (`packages/server/src/routes/events.ts:126`) and its engine is a local Vercel-AI-style loop (`packages/server/src/engine/index.ts:397`) with provider abstractions, MCP routing, UI/governance, and Helm packaging. Those are useful product ideas but not our current architecture: ADR 0001 keeps Pi as loop owner, and ADR 0009 keeps UUIDv7 `sevt_*` IDs as cursor truth.

Net: borrow the contract-test discipline, not the engine, event cursor, or full-stack product shape.

## Adoption discipline

These patterns are standard engineering practices, not proprietary inventions. Implementations are written from scratch to fit our codebase. When extending an alignment test or adding a new contract guard, contributors should reference the *technique* (e.g., "regex-scan source files for emitted event-type literals") rather than a specific external implementation. If we ever do borrow code verbatim from a project with a license whose terms we haven't accepted for this project, that's a separate license decision — not a routine adoption.

## What we don't adopt

| Item | Why |
|---|---|
| Runtime-level event log / replay implementations from external projects | Our Flue-derived replay-then-tail (ADR 0007 Pattern 1) is the architectural pick; competing implementations we've evaluated have reconnect races or unsafe cursor strategies. |
| Cursor strategies that order by `processed_at` and filter by timestamp | Unsafe for same-ms events. We use stable UUIDv7 IDs as cursor truth (ADR 0007). |
| Direct Vercel AI SDK / non-Pi loop implementations | Violates ADR 0001 (Pi owns the loop). |
| Multi-provider seeding, MCP client wrappers, Helm/Docker packaging | All post-MVP. |

## Implementation order

1. **Now:** ADR 0008 + `specs/` files + EventType alignment test v1 (this commit batch).
2. **Vertical slice next step:** ApiError classes (Pattern 4 from ADR 0007) + Hono routes. When routes exist, expand the alignment test to v2 (regex-scan source files).
3. **Post-MVP:** Schema-handler alignment lint; Web/CLI contract test; CI smoke topology.
