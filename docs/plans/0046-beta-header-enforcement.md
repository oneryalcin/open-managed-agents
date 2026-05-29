# Plan: Managed Agents Beta Header Enforcement

Issue: [#46](https://github.com/oneryalcin/open-managed-agents/issues/46)

## Goal

Require `anthropic-beta: managed-agents-2026-04-01` on OMA's Managed Agents
route surface, while preserving existing forward-compatible parsing for extra
beta values.

## Live Contract Evidence

Probe:

```bash
ANTHROPIC_API_KEY=... python scratch/31-managed-agents-beta-header-probe.py
```

Captured output:

- `scratch/artifacts/31-managed-agents-beta-header-probe-output.txt`

Findings:

1. Hosted `/v1/agents` and `/v1/sessions` are hidden unless the
   `managed-agents-2026-04-01` beta is present. Missing, future-only, and
   environments-only beta values return 404 `not_found_error` with `not found`.
2. Hosted `/v1/agents` and `/v1/sessions` accept
   `managed-agents-2026-04-01, future-beta`.
3. Hosted `/v1/environments` has two beta surfaces. `environments-2025-11-01`
   returns a different list shape, while `managed-agents-2026-04-01` returns the
   Managed Agents-compatible environment list shape OMA implements.
4. Hosted `/v1/files` accepts `managed-agents-2026-04-01`; it also accepts other
   known file/environment beta values. Future-only extra values without a known
   accepted value reject.

OMA will enforce the current OMA surface, not every hosted beta variant:

- require `managed-agents-2026-04-01` for `/v1/agents`, `/v1/environments`,
  `/v1/files`, `/v1/sessions`, and nested session event routes.
- allow additional unknown beta values when the required Managed Agents beta is
  present.
- leave standalone hosted beta variants such as `environments-2025-11-01` and
  strict unknown-value rejection out of scope.

## Design

1. Parse beta features once near the top of `createControlPlaneApp`.
2. Enforce beta before body parsing/body-size work.
   - Missing required beta should fail cheaply without reading JSON,
     multipart bodies, or SSE/event payloads.
3. Protect only known Managed Agents route prefixes:
   - `/v1/agents`
   - `/v1/environments`
   - `/v1/files`
   - `/v1/sessions`
4. Do not protect unknown routes such as `/v1/unknown`; keep the existing route
   not-found behavior.
5. Rejection shape:
   - 404
   - `not_found_error`
   - message `not found`

This matches the hosted Managed Agents agents/sessions behavior and avoids
teaching clients route details when the beta gate is missing.

## Acceptance Criteria

1. Missing beta rejects agents, environments, files, sessions, and session event
   routes with 404 `not_found_error`, message `not found`.
2. Wrong-only beta values, including `future-beta` or
   `environments-2025-11-01` without the Managed Agents beta, reject the same
   way.
3. `managed-agents-2026-04-01` succeeds on existing happy-path tests.
4. `managed-agents-2026-04-01, future-beta` succeeds, preserving
   forward-compatible parsing.
5. Unknown routes still return the existing `Route not found` error.
6. Files upload body-limit and multipart parsing remain scoped after the beta
   gate.
7. Inert `?beta=true` query parameters are removed from tests/probes.

## Tests

Add or update tests to cover:

- `parseBetaFeatures` behavior remains unchanged.
- each route family rejects missing beta:
  - agents
  - environments
  - sessions
  - session events
  - files
- wrong-only beta rejects.
- required beta plus future beta succeeds.
- unknown route stays `Route not found`.
- oversized/malformed body tests send the required beta when testing body
  behavior, so they do not accidentally assert beta-gate behavior.

## Non-Goals

- No strict hosted unknown-beta rejection when the required beta is present.
- No standalone `environments-2025-11-01` implementation.
- No files-specific beta variant enforcement.
- No auth or API-key enforcement.
- No route-level beta checks scattered through individual route files.
