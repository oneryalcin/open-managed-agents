# ADR 0012: Session continuity keyed by `sesn_*` before C.3 live validation
**Status:** Accepted, 2026-05-26

## Context

Cycle C.2 currently wires runtime execution from `events.send(user.message)` into
the existing event-log path. The current `PiSessionRunner` creates a fresh Pi
`AgentSession` for each user message call. That gives correct transport behavior
for C.2 (translate -> persist -> stream/list) but does **not** provide
multi-turn continuity for a managed session ID (`sesn_*`).

If this remains implicit, a C.3 happy-path live probe can appear green while
session continuity is still missing.

## Decision

Treat per-`sesn_*` runtime continuity as a **named prerequisite** before C.3 live
validation is considered complete.

- C.2 is explicitly a transport/runtime-ingestion spike.
- C.3 must not be signed off as "live-ready" until runtime state is keyed by
  `sesn_*` (or an equivalent persisted runtime identity) and turn ordering is
  serialized per session.
- C.3a uses Pi's native turn queueing instead of a control-plane mutex:
  `prompt(...)` when idle, `followUp(...)` for `user.message` while running, and
  `steer(...)`/`abort()` for interrupt behavior once `user.interrupt` is wired.

## Evidence

`scratch/11-pi-session-continuity.ts` captured the C.3a gating behavior against
Pi 0.75.4 / `claude-haiku-4-5`; the committed summary lives at
`scratch/artifacts/pi-session-probe/_capability-summary.json`.

- Continuity works: one Pi `AgentSession` remembered a unique phrase across two
  `prompt(...)` calls.
- Busy-session behavior is natively queued by Pi: `prompt(...)` without
  `streamingBehavior` throws while running, while `prompt(...,
  {streamingBehavior:"followUp"})`, `prompt(...,{streamingBehavior:"steer"})`,
  `followUp(...)`, and `steer(...)` all resolve and produce a second assistant
  turn.
- Abort survives: after `abort()`, the same Pi `AgentSession` accepted another
  `prompt(...)` and replied.

## Consequences

1. Current per-message cold start is allowed only as an interim C.2 limitation.
2. C.3 acceptance must include continuity evidence (at least one multi-turn run
   where later turns depend on prior turn context).
3. Per-session turn ordering belongs to the same continuity milestone, but the
   mechanism is Pi-native queueing, not a separate mutex, unless a later probe
   disproves the observed behavior.
4. Runtime session cache must be memory-bounded: idle-TTL eviction and
   dispose-on-hard-error are part of the continuity work. Abort alone does not
   force eviction.

## Rejected alternative

Keep the stateless runner implicit and proceed to C.3 live checks anyway.

Why rejected: it creates a false-positive validation path where transport works
but managed session semantics are not actually implemented.
