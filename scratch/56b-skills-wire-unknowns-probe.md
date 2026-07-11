# Probe 56b — `/v1/skills` wire unknowns (panel-flagged)

Run: `python3 scratch/56b-skills-wire-unknowns-probe.py`. Artifact:
`scratch/artifacts/56b-skills-wire-unknowns-probe.json`. Date 2026-07-10. Closes
the `[Unk]` items the panel flagged as shaping slice 1.

## Findings (all [Obs] now)

| Question | Result |
|---|---|
| Root-level SKILL.md zip (no folder) | **400** — "Zip must contain a top-level folder with all files inside it, including SKILL.md". Hosted **requires** a single top-level folder; root-level is rejected. |
| `name` != folder name (`name_dir_mismatch` in artifact) | **400** — "The folder name '…' must match the skill name '…' in SKILL.md." **name == directory is ENFORCED at upload.** (Now captured in the artifact with the exact message; earlier runs asserted this from a separate manual call.) |
| Path-qualified individual `files[]` (no zip) | **200 accepted** (`files[]` = `<name>/SKILL.md` as one part). |
| Omitted `display_title` | **derived from the SKILL.md `name`** (not a prettified title) — got `display_title == name`. |
| Duplicate `display_title` | **400** — "Skill cannot reuse an existing display_title: …". Uniqueness enforced (distinct from name). |
| 30 MB boundary (32.5 MB upload) | **413** `request_too_large` — "The Skills API accepts requests up to 30MBs." A **request-size (compressed) cap**, HTTP 413. |
| Delete a skill an agent references | **200** — no referential protection; the delete succeeds. |
| Agent after its skill is deleted | **200**, still echoes the **dangling ref** `{skill_id, type:"custom", version:"latest"}`. |
| Re-attach a deleted `skill_id` to a new agent | **400** invalid_request_error (existence checked at attach). |
| Pagination (`limit=1`) | **Anomaly:** `has_more=false`, `next_page=null` despite multiple skills present. Hosted pagination semantics unclear here (probe 56's `limit=3` DID page); low-stakes — OMA implements its own cursor. Flagged for parity follow-up. |

## Consequences for plan 0126

- **name == directory** is forced by hosted → mounting at `/workspace/skills/<name>/`
  is unambiguous; the directory-vs-name `[Unk]` is resolved. OMA mirrors the
  upload rule (already D2/D9).
- **Zip layout:** require a single top-level folder (NOT root-level). Correct D2.
- **30 MB → 413** request-size cap (not 400) → the dedicated bodyLimit returns
  413 with the hosted message; matches D2's layered-limit design.
- **Referenced deletion:** delete is allowed, the agent keeps a dangling ref,
  re-attach fails. OMA matches this at the agent/wire level; D4's session
  snapshot additionally retains bytes for a *live session* (more protective than
  hosted — acceptable, and correct for reproducibility).
- **display_title uniqueness** (distinct from name uniqueness) is a real
  constraint with an exact message → add to D9.
- **Per-file multipart** accepted → the route must handle both zip and
  path-qualified `files[]` (Hono `parseBody({all:true})`, D2).
