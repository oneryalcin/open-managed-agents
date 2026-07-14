# Plan 0135 -- Alpha OpenAPI and interactive API documentation

Status: implemented; independent review and browser rendering check pending

Date: 2026-07-14

## Goal

Give local operators FastAPI-like API discovery without creating a second,
hand-maintained contract that can drift from OMA's runtime. Expose a
machine-readable OpenAPI document at `/openapi.json` and a vendored,
air-gap-safe interactive UI at `/docs/`.

## Required contract

- `/openapi.json` is public and contains no deployment secrets or live data.
- `/docs` redirects to `/docs/`; `/docs/` works without network egress.
- `/` remains the operator-console entrypoint and redirects to `/console/`.
- CMA-compatible `/v1` operations and OMA operator/admin operations are tagged
  separately.
- The schema documents `x-api-key`, `x-admin-key`, and the required
  `anthropic-beta: managed-agents-2026-04-01` header at their actual scopes.
- Request, success, pagination, and error envelopes are represented.
- Session event send/list and SSE behavior include concrete examples and the
  currently supported event types.
- Unsupported CMA operations are omitted, not marked as if they work.

## Schema ownership

Do not write a large static OpenAPI file disconnected from route validation.
Introduce a small route-contract registry whose entries own:

- method and path;
- operation id, tags, and summary;
- path/query/header parameters;
- request schema where applicable;
- success and error response schemas.

Routes should consume the same TypeBox schemas used by the registry. Existing
manual validators can migrate incrementally, but CI must compare every shipped
`/v1` and `/admin` method/path with the registry and fail for undocumented or
stale operations. Runtime behavior remains authoritative during migration.

## Documentation UI

Vendor a pinned release of a small OpenAPI renderer under the bundled UI tree.
Do not load JavaScript, CSS, fonts, or telemetry from a CDN. Serve assets with
the same containment, extension allowlist, and `no-store` posture as the
operator console. Record package version and integrity provenance.

The UI must allow operators to enter API/admin keys in page memory only. Do
not persist credentials in cookies, local storage, session storage, URLs, or
server logs.

## Delivery sequence

1. Inventory all current `/v1`, `/admin`, health, and metrics routes.
2. Add shared security/error/pagination schemas and the route registry.
3. Cover the synchronous alpha path first: agents, environments, sessions,
   session events, files, skills, vaults, and secrets.
4. Add remaining shipped endpoints and enforce complete route/spec coverage.
5. Serve `/openapi.json` with canonical deterministic output.
6. Vendor and serve the interactive `/docs/` UI.
7. Add security tests for credential persistence, unknown assets, traversal,
   and docs availability without authentication or network access.

## Acceptance gates

- A clean appliance exposes `/openapi.json` and `/docs/`.
- The document validates as OpenAPI and has stable snapshot/canonical tests.
- Every shipped API route is represented exactly once with the correct method.
- Required auth/beta headers are visible and usable in the interactive UI.
- Representative examples execute successfully against a test appliance.
- No unsupported endpoint or event capability is advertised.
- Documentation assets make zero external network requests.
