# Probe 65b — hosted `glob` pattern grammar

Date: 2026-07-13
Status: complete
Artifact: `scratch/artifacts/65b-managed-agents-glob-pattern-probe.json`

## Method

A hosted cloud session created a small corpus and issued seven exact calls for
`?`, character classes, ranges, braces, escaping, and an explicitly relative
path. Tool-use IDs and result references are retained as stable per-artifact
pseudonyms, so every result is directly correlated to its input. The probe
script reads the credential directly from the project `.env` described in
probe 65.

Run:

```bash
uv run --with anthropic python scratch/65b-managed-agents-glob-pattern-probe.py
```

## Observations

- `?.md`, `[ab].md`, and `[a-c].md` each matched `a.md` and `b.md`.
- `{a,b}.md` also matched `a.md` and `b.md`.
- Backslash escaping behaved directly: `q\?.md` matched only literal `q?.md`,
  and `\[literal\].md` matched only literal `[literal].md`.
- Explicit relative path `mnt/session/glob65b` was accepted and produced
  relative result paths with the same prefix, including nested descendants.
- All seven calls succeeded and used ordinary permission/tool events.

## Consequence

The CMA-compatible grammar must support `*`, `**`, `?`, character classes and
ranges, brace alternatives, and backslash escaping of metacharacters. OMA must
not reuse its current matcher unchanged because that matcher escapes bracket
syntax. Explicit relative paths must preserve relative output formatting.
