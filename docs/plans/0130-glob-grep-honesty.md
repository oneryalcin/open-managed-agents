# Plan 0130 — Honest `glob`/`grep` parity boundary

Date: 2026-07-13
Branch: `arc-f-glob-grep-honesty`
Evidence: [probe 64](../../scratch/64-managed-agents-tool-glob-grep-probe.md)

## Problem

CMA's agent tool vocabulary includes `glob` and `grep`. OMA's tool-config
validator accepts those names, but the runtime only exposes Pi's `find` tool;
`grep` is absent. This is an accepted-but-inert capability claim.

## Probe and source findings

Hosted probe 64 established one observed invocation shape:

- `glob` input is `{pattern, path?}` and returns matching absolute paths as
  text.
- `grep` input uses `{pattern, path?, glob?, context?, head_limit?}` and returns
  matching path/line text. The wire field is `head_limit`, not Pi's `limit`.
- Both use ordinary `agent.tool_use`/`agent.tool_result` events and permission
  evaluation.

Pi 0.80.6 exports `createGrepTool` and `createFindTool`. `createGrepTool`'s
`GrepOperations` only overrides `isDirectory` and `readFile`; its search still
spawns `rg` in the Pi process. OMA's Docker and microsandbox providers currently
expose only `find` and do not provide a sandboxed grep operation.

## Decision

For this bounded slice, reject any effectively enabled `glob`, `grep`,
`web_fetch`, or `web_search` configuration at agent creation with a stable
`400 invalid_request_error`. OMA deliberately defines omitted unsupported names
as deployment-disabled defaults and materializes those overrides in the stored
response. Explicit configurations combine with `default_config.enabled`, so
disabled configurations remain valid while effectively enabled ones reject.
Do not translate `glob` to `find`, and do not run
Pi's default grep from the control-plane process.

## Invariants

1. A new agent cannot persist a `glob` or `grep` config that OMA cannot execute.
2. The rejection happens before `AgentStore.create`.
3. The error is explicit and names the unsupported tool.
4. Existing agents/legacy rows remain readable; runtime behavior is unchanged
   for them until migration or a future runtime slice.
5. No host-side `rg` execution is introduced as a substitute for sandboxing.

## Implementation and tests

- Add a CMA-name-to-OMA-runtime support check after closed-set validation.
- Add API tests for `glob` and `grep` rejection and no-row behavior, while
  retaining valid `bash`/`read`/`write`/`edit` coverage.
- Keep the probe artifact and source inspection findings committed.
- Update parity and handoff docs to distinguish honest rejection from the later
  full runtime parity arc.

## Follow-up: full runtime slice

Split the runtime follow-up by tool. `glob` can adapt the safe glob operations
already implemented by both sandbox providers, adding the CMA schema, output,
and event wiring. Keep `grep` rejected until providers own content search and a
deterministic search-binary strategy. Run real provider tests before accepting
either name.
