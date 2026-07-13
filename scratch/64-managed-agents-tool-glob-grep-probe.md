# Probe 64 — hosted `glob`/`grep` tool shapes

Date: 2026-07-13
Status: complete
Artifact: `scratch/artifacts/64-managed-agents-tool-glob-grep-probe.json`

## Method

A hosted agent was created with `glob` and `grep` enabled and
`always_allow`. A session mounted a small Markdown file at
`/mnt/session/uploads/probe64.md`. The agent was instructed to call each tool
exactly once and the event stream was captured without durable IDs.

Run:

```bash
uv run --with anthropic python scratch/64-managed-agents-tool-glob-grep-probe.py
```

## Findings

This probe records one observed invocation of each tool; it does not independently
establish the complete optional-field schema.

- `glob` tool use emitted:

  ```json
  {"path":"/mnt/session/uploads","pattern":"*.md"}
  ```

  Its successful result was a text block containing the matching absolute path:
  `/mnt/session/uploads/probe64.md`.

- `grep` tool use emitted:

  ```json
  {
    "context": 1,
    "glob": "*.md",
    "head_limit": 5,
    "path": "/mnt/session/uploads",
    "pattern": "probe"
  }
  ```

  Its successful result was a text block containing the matching absolute path
  for this one-line file. The hosted wire uses `head_limit`, not Pi's
  `limit` field.

- Both calls emitted `evaluated_permission: "allow"` and ordinary
  `agent.tool_use` / `agent.tool_result` events.

## Decision for this slice

OMA's Pi 0.80.6 SDK exports `createGrepTool`, but its default implementation
spawns `rg` in the process running the control plane. Its pluggable
`GrepOperations` only replaces directory checks and file reads; it does not
move the search process into Docker or microsandbox. OMA's providers currently
expose only Pi's `find` tool and do not provide a sandboxed grep operation.

Do not wire a partial host-executed implementation. Omitted `glob` and `grep`
materialize as disabled deployment defaults; explicit configurations reject
only when effectively enabled. Implement CMA-facing `glob` by adapting the safe
operations already available in both sandbox providers. Keep `grep` rejected
until providers own content search and a deterministic search-binary strategy.
