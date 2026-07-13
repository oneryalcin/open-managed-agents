# Probe 65 — hosted `glob` edge cases

Date: 2026-07-13
Status: complete
Artifact: `scratch/artifacts/65-managed-agents-glob-edge-probe.json`

## Method

A hosted cloud session first used `bash` to create a deterministic corpus under
`/mnt/session/glob65`, including nested files, dotfiles, a `.gitignore`, a
`node_modules` subtree, and 150 numbered files. The agent then made eight exact
`glob` calls covering default path, no matches, missing path, recursion,
ordering/formatting, hidden files, result limits, and a malformed pattern.

Run:

```bash
uv run --with anthropic python scratch/65-managed-agents-glob-edge-probe.py
```

The script reads the probe credential directly from
`/Users/oner/dev/junk/cwc-workshops/.env`; it does not use an ambient API key.

## Observed behavior

- **Omitted `path`:** `{"pattern":"*.md"}` searched from the session's default
  working directory, recursed into descendants, and returned paths without a
  leading slash (for example `mnt/session/glob65/z.md`). The 100-result cap
  prevented this call from enumerating the whole default tree.
- **No matches:** returned the successful text result `No files found` with
  `is_error: false`.
- **Missing path:** returned the shell text
  `/bin/sh: 1: cd: can't cd to /mnt/session/glob65/missing` with
  `is_error: true`.
- **Recursive patterns:** `**/*.md` returned files at the path root and at every
  tested descendant depth.
- **Plain patterns recurse too:** `*.md` produced the same seven results as
  `**/*.md`; CMA glob is not a single-directory filesystem glob.
- **Path formatting:** with an explicit absolute `path`, results were absolute.
  With omitted `path`, results were relative to the default working directory.
- **Ordering:** results were not lexicographically sorted. The probe records one
  observed order but does not establish a stable ordering contract.
- **Limits:** a 150-file match returned exactly 100 lines, silently truncated,
  with `is_error: false` and no truncation marker or details object.
- **Hidden and ignored files:** `.*` returned `.hidden.md` and `.gitignore`.
  Ordinary `*.md` included `.hidden.md`, `ignored.md` despite `.gitignore`, and
  `node_modules/pkg/dependency.md`. No tested ignore rule was applied.
- **Malformed pattern:** `[` returned
  `rg: error parsing glob '[': unclosed character class; missing ']'` with
  `is_error: true`.
- Every call used ordinary `agent.tool_use` / `agent.tool_result` events and was
  permission-evaluated as allowed.

## Scope and implementation consequence

These are observed hosted behaviors for this corpus and model, not a claim that
all internal ordering or error strings are stable API contracts. They are enough
to rule out renaming Pi's `find`: OMA needs a CMA-specific tool definition and
result formatter backed by sandbox-owned `FindOperations.glob`.
