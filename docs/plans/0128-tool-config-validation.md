# Plan 0128 — CMA tool-config validation

Date: 2026-07-13
Branch: `main` after networking parity PR #180
Evidence: [probe 63](../../scratch/63-managed-agents-tool-config-validation-probe.md)

## Problem

OMA currently accepts arbitrary `agent_toolset_20260401.configs[].name` and
permission-policy strings. The values can persist while the runtime either
cannot expose the named tool or maps an unknown policy to deny. That makes a
successful agent create an unreliable capability claim.

## Evidence-backed contract

Probe 63 against hosted CMA established:

- Builtin agent tool names are exactly `bash`, `edit`, `glob`, `grep`, `read`,
  `web_fetch`, `web_search`, and `write`. `find` is rejected; OMA's internal
  Pi name is not a CMA wire name.
- Permission policies accepted in the tested agent toolset are
  `always_allow` and `always_ask`. `never_allow`, `always_deny`, `deny`, and an
  unknown sentinel are rejected.
- If omitted, the hosted response materializes
  `default_config.enabled: true`, `default_config.permission_policy.type:
  "always_allow"`, and `configs: []`.
- Duplicate builtin configs by name are rejected, including same-policy and
  conflicting-policy duplicates. A second builtin toolset is rejected.
- For a single config containing both an unknown name and unknown policy, the
  policy error wins. An unknown policy also wins over duplicate detection.
  Mixed-invalid precedence is path-sensitive; the probe artifact records the
  observed cases and we do not infer a universal ordering from them.
- MCP toolset config names are not part of this closed set: they are discovered
  from the referenced server and remain out of this slice.

## Scope

### In scope

- Validate CMA builtin tool names at agent create for
  `agent_toolset_20260401.configs[]`.
- Validate permission-policy vocabulary for builtin and MCP toolset default and
  per-tool configs.
- Reject duplicate builtin config names and preserve the existing one-toolset
  limit.
- Add focused API/service tests for unknown names, unknown policies, duplicate
  configs, valid hosted names, and error precedence.
- Materialize OMA's implicit default config in the agent response, matching the
  observed hosted response.

### Non-goals

- Do not rename or wire Pi's internal `find` tool here. The `glob`/`grep` parity
  slice remains separate.
- Do not implement `web_fetch` or `web_search` runtime execution here; accepting
  their documented configuration is a wire-vocabulary fix, not a claim that the
  web runtime is shipped.
- Do not validate MCP `configs[].name` against the builtin set; MCP names are
  server-defined. MCP duplicate semantics require a separate probe if needed.
- Do not implement agent versioning or reject the inert `multiagent` field in
  this slice.

## Invariants

1. A request with an unknown builtin tool or permission policy cannot create an
   agent row.
2. A builtin config name occurs at most once per builtin toolset.
3. Native/internal rows may still contain legacy `never_allow` values for
   runtime compatibility, but the public create wire rejects values CMA rejects.
4. Agent response defaults are deterministic and do not mutate the caller's
   request object.
5. MCP toolset config names remain arbitrary strings because their vocabulary is
   discovered at runtime.

## Implementation

- Add centralized constants and validators in `agents/service.ts`.
- Pass a builtin-vs-MCP context into config parsing; only builtin names use the
  CMA closed set.
- Parse policies before names within a config so an unknown policy wins over an
  unknown name, matching the observed hosted case.
- Detect duplicate builtin names after each config has been structurally and
  semantically validated.
- Have `optionalDefaultConfigSpread` materialize `enabled: true`,
  `always_allow`, and `configs: []` for builtin toolsets when omitted, while
  preserving the existing MCP response shape and explicit values.
- Keep persisted input semantics otherwise unchanged.

## Acceptance criteria

- API create returns 400 `invalid_request_error` for `find`, arbitrary names,
  `never_allow`, and arbitrary policy strings.
- API create accepts all eight observed builtin names and both observed policy
  types.
- Duplicate builtin configs return 400 and no agent row is created.
- The response for an agent toolset with no config includes the implicit default
  and empty `configs` array.
- MCP toolset configs with arbitrary server-defined names remain accepted.
- Typecheck, focused agent tests, and full Vitest pass.
