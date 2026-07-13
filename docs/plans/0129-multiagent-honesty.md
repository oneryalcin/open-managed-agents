# Plan 0129 — Reject inert multiagent configuration

Date: 2026-07-13
Branch: `arc-e-multiagent-rejection`

## Problem

OMA accepts and persists a non-null `multiagent` agent configuration, but has
no coordinator runtime, delegation tool, thread routes, or thread events. A
successful create therefore claims a capability that cannot execute.

## Decision

Reject every non-null `multiagent` value at agent creation with a stable
`400 invalid_request_error`:

> The `multiagent` configuration is not supported by this deployment.

An omitted field and explicit `null` remain equivalent to no configured
multiagent runtime and are accepted for compatibility. Existing legacy rows
that contain the field remain readable; this slice changes only new writes.

## Invariants

1. No non-null multiagent request reaches `AgentStore.create`.
2. All non-null shapes—including malformed objects, strings, and numbers—use
   the same public error type and message rather than leaking parser detail.
3. A failed create leaves no agent row.
4. `multiagent: null` remains accepted and round-trips as `null`.
5. No runtime, thread, roster, or persistence migration work is included.

## Implementation

- Reject immediately after request-body object validation and before parsing other
  agent fields or constructing the row.
- Retain only the absent/null distinction in the parser for the response shape.
- Add API regression coverage for valid coordinator-shaped, malformed, scalar,
  and null values, including a no-row assertion.
- Mark the accepted-but-inert parity gap resolved in `PARITY.md` as an honest
  rejection, while keeping the full multiagent runtime in the post-v1 deferrals.

## Non-goals

- Do not implement delegation or `/threads` routes.
- Do not reject legacy database rows on retrieve.
- Do not change the planned `glob`/`grep`, pagination, or agent-versioning work.
