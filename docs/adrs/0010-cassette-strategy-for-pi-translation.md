# ADR 0010: Cassette Strategy for Pi Translation

**Status:** Accepted, 2026-05-26

## Context

Cycle C introduces Pi runtime translation. The high-risk failure mode is silent drift in upstream Pi event shapes and ordering semantics that only appears during live runs. We need deterministic regression coverage that:

- runs in CI without live API dependencies,
- exercises the same translator path as runtime ingestion,
- makes upstream drift visible as small, reviewable fixture diffs.

Cycle C.0 already produced raw event captures in `scratch/artifacts/pi-events/*.jsonl` across four trajectories:

1. simple message
2. tool call
3. tool throw
4. abort

## Decision

Use static JSONL cassettes as translator fixtures, replayed through the same per-event translation function used in runtime code.

### Scope of this decision

- **In scope**
  - Fixture format (`jsonl`, one event per line with scenario metadata)
  - Replay mechanism (read lines, feed events to `translatePiEvent`)
  - Required baseline trajectories (the four above)
  - Refresh policy tied to Pi SDK changes
- **Out of scope**
  - HTTP interception/VCR frameworks
  - End-to-end transport assertions (covered by B.2/B.3 tests and C.2/C.3)

## Why this over alternatives

| Alternative | Why rejected |
|---|---|
| Live Pi integration tests only | Non-deterministic, slower, and poor at isolating translator regressions. |
| Full VCR/interception framework | Higher complexity with little added value for per-event translation logic. |
| Hand-authored synthetic fixtures | Too easy to drift from actual Pi behavior; misses real event granularity. |

## Refresh policy

- On Pi SDK version change, run C.0 probe (`scratch/10-pi-event-dump.ts`) and review fixture diffs explicitly.
- Do not auto-accept fixture churn; each changed field/type/order is a compatibility review point.
- Translator behavior changes must be justified against fixture evidence and docs.

## Consequences

- Translator tests become deterministic and fast.
- Upstream drift becomes visible in pull requests as fixture diffs.
- The fixture set is now a compatibility artifact, not scratch output.

