# Probe 68 -- hosted CMA `grep` edge behavior

Date: 2026-07-14
Status: complete
Artifacts:

- `scratch/artifacts/68-managed-agents-grep-edge-probe.json`
- `scratch/artifacts/68b-managed-agents-grep-path-limit-probe.json`
- `scratch/artifacts/68c-managed-agents-grep-path-errors-probe.json`

## Method

Hosted agents were created with only `grep` enabled and `always_allow`.
Sessions mounted small probe files under `/mnt/session/uploads`. The agents
were instructed to call `grep` with exact JSON inputs, and event streams were
captured with hosted IDs pseudonymized.

Run:

```bash
uv run --with anthropic python scratch/68-managed-agents-grep-edge-probe.py
uv run --with anthropic python scratch/68b-managed-agents-grep-path-limit-probe.py
uv run --with anthropic python scratch/68c-managed-agents-grep-path-errors-probe.py
```

## Findings

- Input shape follows probe 64: `pattern` plus optional `path`, `glob`,
  `context`, and `head_limit`.
- Successful results are newline-delimited matching file paths, not matching
  lines. This held even with `context: 1` and multiple matching lines in a file.
- No matches succeeds with text `No matches found`.
- `head_limit` caps returned file paths. With four matching files and
  `head_limit: 2`, hosted returned exactly two paths.
- `glob` filters searched files. `glob: "*.md"` excluded a matching `.txt`
  file.
- Omitting `glob` searched all files under the explicit `path`.
- Explicit absolute nested paths returned absolute nested file paths.
- Invalid regex returns an error tool result with `is_error: true` and an `rg`
  parse error string.
- Missing path returns an error tool result with `is_error: true` and an `rg`
  no-such-file string.
- Binary-ish file content containing NUL bytes was not searched by the hosted
  result observed here: `BINARY68` in `*.bin` returned `No matches found`.
- Explicit relative `path: "relative"` did not resolve from
  `/mnt/session/uploads`; hosted returned an `rg: relative: No such file or
  directory` error.
- Omitted `path` was attempted in probe 68b but did not produce a result before
  the probe timeout. Treat omitted-path semantics as unprobed for implementation
  rather than claiming parity.
- Result ordering is not stable. In one run the returned path order was
  `multi3`, `multi1`, `multi2`, `multi4`.

## Implementation consequences

- OMA should expose a CMA-named `grep` tool only after providers own execution.
- The public output should be matching paths, not line/context snippets, until
  stronger hosted evidence proves otherwise.
- `head_limit` should limit matched files, not matched lines.
- Exact hosted `rg` error strings are not portable requirements, but invalid
  regex and missing path must be tool errors.
- Do not use Pi's host-process `rg` implementation.
