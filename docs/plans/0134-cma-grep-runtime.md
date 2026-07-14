# Plan 0134 -- Provider-owned CMA `grep`

Date: 2026-07-14
Status: ready for implementation
Branch: `arc-j-cma-grep-probe`
Evidence: [probe 64](../../scratch/64-managed-agents-tool-glob-grep-probe.md),
[probe 68](../../scratch/68-managed-agents-grep-edge-probe.md)

## Goal

Expose CMA's `grep` builtin through a bounded, cancellable, provider-owned
operation. Do not wire Pi's host-process `rg` path. `grep` must search the
session filesystem inside Docker or microsandbox, respect OMA permission and
event accounting, and remain disabled until both providers own execution.

## Hosted behavior observed

Probe 64 established the happy-path input shape:

```json
{
  "context": 1,
  "glob": "*.md",
  "head_limit": 5,
  "path": "/mnt/session/uploads",
  "pattern": "probe"
}
```

Probe 68 adds the implementation-relevant edge behavior:

- successful results are newline-delimited matching file paths, not matching
  lines, even when `context` is non-zero;
- no matches succeeds with text `No matches found`;
- `head_limit` caps returned file paths;
- `glob` filters searched files;
- omitted `glob` searches all files under an explicit path;
- invalid regex and missing path are error tool results;
- binary-ish files with NUL bytes were not searched in the observed hosted
  result;
- explicit relative paths did not resolve from `/mnt/session/uploads`;
- omitted `path` timed out in the probe and remains unclaimed.

## Current OMA anchors

- `grep` is a valid CMA builtin name but remains deployment-disabled in
  `src/control-plane/agents/service.ts`.
- `SandboxOperations` has provider-owned `glob` but no provider-owned `grep`
  in `src/control-plane/sessions/pi/sandbox/provider.ts`.
- `PiSessionRunner` exposes only provider tool definitions in
  `enabledSandboxTools`; once providers include `grep`, permission and
  confirmation wrapping follow the existing builtin path.
- Docker and microsandbox already have token-scoped command cleanup patterns
  for CMA `glob` in `src/control-plane/sessions/pi/sandbox/docker.ts` and
  `src/control-plane/sessions/pi/sandbox/microsandbox.ts`.

## Design

### D1 -- Provider-owned operation

Add a separate operation; do not reuse Pi's `createGrepToolDefinition`.

```ts
interface CmaGrepOperations {
  grep(input: {
    pattern: string;
    cwd: string;
    signal: AbortSignal;
    path?: string;
    glob?: string;
    context?: number;
    headLimit: number;
    maxRawBytes: number;
    maxOutputBytes: number;
    timeoutMs: number;
  }): Promise<string[]>;
}
```

The return value is matching paths. The public tool formats:

- matches: newline-delimited paths;
- no matches: `No matches found`;
- provider errors: tool error result.

`context` is accepted for wire parity but does not change output until hosted
evidence shows line-context output. Keep this explicit in tests.

### D2 -- Deterministic search engine

Use `rg` only if it is executed inside the provider boundary. The implementation
must not depend on an accidental host binary. For Docker/microsandbox, choose
one of these during implementation:

1. execute an available in-guest `rg`/`grep` with a deterministic preflight and
   fail closed if missing; or
2. implement content search in the provider by streaming file bytes from the
   guest.

The first implementation may use in-guest `rg` if tests prove the default
runtime image has it. If not, use provider-owned traversal plus bounded file
reads instead of broadening the image story in this slice.

### D3 -- Bounds and lifecycle

Reuse the `glob` lifecycle shape:

- token-scoped guest process ownership;
- readiness acknowledgement before public output;
- abort signal forwarding;
- timeout;
- raw stdout/stderr ceiling;
- formatted output ceiling;
- cleanup awaited before success/error resolution;
- poison/dispose the sandbox if pre-readiness cancellation or cleanup
  uncertainty means delayed guest work may outlive the operation.

Suggested initial constants mirror `glob` unless tests show tighter values are
needed:

- max matched files: `head_limit` clamped to 100;
- raw stream: 1 MiB;
- formatted output: 64 KiB;
- timeout: 10 seconds.

### D4 -- Path, glob, and regex semantics

- Resolve explicit absolute paths inside the sandbox boundary.
- Treat explicit relative paths conservatively: either reject as unsupported or
  resolve from provider `cwd`; do not silently pretend it means
  `/mnt/session/uploads`.
- Omitted path is unprobed because hosted did not complete in probe 68b. Start
  with provider `cwd` only if bounded tests prove it cannot scan outside the
  session workspace.
- Apply `glob` as a file filter before content search.
- Pass regex syntax through to the chosen engine. Invalid patterns must become
  tool errors.
- Treat binary files consistently: initial behavior may skip binary-ish files,
  matching the hosted observation.

### D5 -- Public exposure

Keep `grep` in `OMA_UNSUPPORTED_BUILTIN_TOOL_NAMES` until:

- Docker provider owns `grep`;
- microsandbox provider owns `grep`;
- runner/accounting tests show public event and accounting name `grep`;
- permission and confirmation tests cover allow, ask, disabled, and denied.

After those pass, remove only `grep` from deployment-disabled defaults.
`web_fetch` and `web_search` remain disabled.

## Tests

- Tool schema: required `pattern`; optional `path`, `glob`, `context`,
  `head_limit`; unknown fields rejected.
- Formatting: match paths, no-match text, `head_limit`, glob filtering,
  invalid regex error, missing path error.
- Provider boundaries: search cannot read host files; absolute paths must stay
  inside the sandbox; relative/omitted path behavior pinned.
- Docker lifecycle: success, no match, invalid regex, raw limit, output limit,
  timeout, caller abort, cleanup failure/poison.
- Microsandbox lifecycle: same coverage as Docker, with a real smoke if the
  gated microsandbox test path is available.
- Runner/accounting: model-facing tool is `grep`; invocation records `grep`;
  Pi host-process grep is not registered.
- Permission/confirmation: `always_allow`, `always_ask`, disabled config, and
  inherited defaults.
- API regression: effectively enabled `grep` rejects until public exposure;
  after exposure, omitted `grep` defaults to enabled like other supported
  builtins.

## Acceptance criteria

- No accepted `grep` configuration is inert.
- No model-facing `grep` reads from the control-plane host filesystem.
- Docker and microsandbox own search execution, limits, cancellation, cleanup,
  accounting, and events.
- Output matches hosted's observed path-list contract.
- `grep` is removed from unsupported defaults only after provider tests pass.
- `web_fetch` and `web_search` remain honestly rejected when enabled.
