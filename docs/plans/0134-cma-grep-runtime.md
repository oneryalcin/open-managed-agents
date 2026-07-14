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
    path: string;
    glob?: string;
    context: number;
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

Use **in-guest BusyBox/POSIX `grep -E` for v1**. This is an explicit OMA
decision, not an accidental fallback:

- the current default Docker image (`bash:5.2`) and microsandbox image
  (`alpine:latest`) expose `/bin/grep`;
- neither default image exposes `rg`;
- shipping a pinned `rg` binary would couple this slice to image/platform and
  supply-chain work that belongs in the later environment-image arc.

This creates a documented regex divergence from hosted CMA: hosted error text
shows `rg`, while OMA v1 uses POSIX extended regular expressions through
`grep -E`. The safety boundary is the product requirement for this slice:
provider-owned, bounded search inside the guest. Ripgrep-compatible Rust regex
parity is deferred.

Provider creation must run a semantic preflight under `LC_ALL=C` before
exposing `grep`; checking command presence or flags alone is insufficient. The
preflight must prove:

1. a valid ERE match exits `0`;
2. a valid ERE no-match exits `1`;
3. an invalid ERE exits with neither `0` nor `1`;
4. `-q` suppresses output;
5. the exact NUL/binary-detection helper used by enumeration identifies a
   NUL-containing sample and leaves a text sample classified as text.

This is a POSIX-ERE behavioral capability check, not an assertion that every
custom image contains a specific BusyBox build. Run all search and preflight
commands with `LC_ALL=C` so locale-sensitive classes and matching do not drift.
An incompatible custom image fails closed before model-facing `grep` is
available. Do not silently fall back to host `rg`, host `grep`, or Pi's
host-process grep path.

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

- max matched files: validated `head_limit`, never above 100;
- raw stream: 1 MiB;
- formatted output: 64 KiB;
- timeout: 10 seconds.

### D4 -- Public input bounds and defaults

Validate before guest dispatch and reject invalid/excessive values as tool
errors rather than silently clamping them:

- `pattern`: required non-empty string, at most 4096 UTF-8 bytes;
- `path`: required for OMA v1, non-empty absolute path, at most 4096 UTF-8
  bytes;
- `glob`: optional non-empty string; use the existing CMA glob pattern-length,
  expansion, and matcher-state limits rather than introducing a second glob
  grammar;
- `context`: optional safe integer from 0 through 100, default `0`; accepted for
  CMA wire compatibility but output-neutral because hosted returned only paths;
- `head_limit`: optional safe integer from 1 through 100, default `100`;
- reject unknown fields at the public tool-schema boundary.

These are explicit OMA safety bounds where probe 68 did not establish hosted
maximums. Provider APIs receive only normalized `context` and `headLimit` after
this validation.

### D5 -- Path, glob, and regex semantics

- Resolve explicit absolute paths inside the sandbox boundary.
- Treat explicit relative paths conservatively. For v1, reject them with a tool
  error instead of guessing a hosted base directory.
- Omitted path is unprobed because hosted emitted a `grep` tool use but no tool
  result before the bounded probe timed out. For v1, require `path` and return
  a tool error when it is omitted. This is a deliberate OMA safety policy, not a
  parity claim.
- Apply `glob` as a file filter before content search.
- Validate regex syntax before file traversal using the in-guest `grep -E`
  preflight path. Invalid patterns must become tool errors.
- Skip binary-ish files containing NUL bytes, matching the hosted observation
  that a NUL-containing `*.bin` file returned `No matches found`.
- Traverse filenames NUL-safely and emit paths exactly as public output. Do not
  normalize result ordering; hosted ordering was not stable.

### D6 -- Public exposure

Keep `grep` in `OMA_UNSUPPORTED_BUILTIN_TOOL_NAMES` until:

- Docker provider owns `grep`;
- microsandbox provider owns `grep`;
- runner/accounting tests show public event and accounting name `grep`;
- permission and confirmation tests cover allow, ask, disabled, and denied.

After those pass, remove only `grep` from deployment-disabled defaults.
`web_fetch` and `web_search` remain disabled.

## Tests

- Tool schema: required bounded non-empty `pattern` and v1 `path`; optional
  bounded `glob`, `context`, and `head_limit`; defaults/ranges above; unknown
  fields rejected before dispatch.
- Formatting: match paths, no-match text, `head_limit`, glob filtering,
  invalid regex error, missing path error.
- Engine preflight under `LC_ALL=C`: match=`0`, no-match=`1`, invalid ERE is
  neither, `-q` emits no output, and the production NUL classifier distinguishes
  binary-ish and text samples; incompatible custom images fail closed.
- Provider boundaries: search cannot read host files; absolute paths must stay
  inside the sandbox; relative/omitted path rejection pinned.
- Binary handling: files containing NUL bytes are skipped.
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
- Public inputs are rejected before dispatch unless they satisfy the explicit
  byte, integer, glob-complexity, absolute-path, and unknown-field rules.
- No model-facing `grep` reads from the control-plane host filesystem.
- Docker and microsandbox own search execution, limits, cancellation, cleanup,
  accounting, and events.
- Output matches hosted's observed path-list contract.
- `grep` is removed from unsupported defaults only after provider tests pass.
- `web_fetch` and `web_search` remain honestly rejected when enabled.
