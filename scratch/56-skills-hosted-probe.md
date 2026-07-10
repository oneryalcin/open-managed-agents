# Probe 56 — hosted Managed Agents Skills API (`/v1/skills`) wire shapes

Run: `python3 scratch/56-skills-hosted-probe.py` (key from CWC `.env`). Raw:
`scratch/artifacts/56-skills-hosted-probe.json`. Date 2026-07-10, beta
`skills-2025-10-02` (+ `managed-agents-2026-04-01` for attach tests).

## Resource shapes (verified)

- **CreateSkill** (`POST /v1/skills`, multipart zip, `files[]`) → 200:
  `{ id: "skill_…", display_title, latest_version, source: "custom", type: "skill", created_at, updated_at }`.
  Wire discriminator is **`type: "skill"`**; `source` is `"custom"` | `"anthropic"`.
- **Version** object (`create_version`, `get_version`, list entries):
  `{ id: "skill_version_…", skill_id, version, name, description, directory, type: "skill_version", created_at }`.
  `name`/`description` come from SKILL.md frontmatter; **`directory`** = the
  zip's top-level folder name. Custom `version` = epoch-timestamp string.
- **GetSkill** = the CreateSkill shape (no inline `versions[]`).
- **ListSkills** (`GET /v1/skills`) → `{ data: [...], has_more: bool, next_page: string|null }`.
  **Anthropic prebuilt skills appear in this list.** This `limit=3` page OBSERVED
  only `xlsx` + `pptx` (`id` = short name, `source: "anthropic"`, date-based
  `latest_version` e.g. `"20260203"`); `docx`/`pdf` are documented but **were not
  in the captured page** — do not cite them as observed (review round 3).
- **ListVersions** → same `{ data, has_more, next_page }` envelope.

## Attachment validation (agent-create)

| Case | Result |
|---|---|
| `{type:"anthropic", skill_id:"xlsx", version:"latest"}` | **200 — accepted & echoed** (version is NOT rejected on anthropic entries, contrary to the "custom only" doc note) |
| `{type:"bogus", skill_id:"xlsx"}` | **400** invalid_request_error |
| `{type:"custom", skill_id:"skill_doesnotexist000"}` | **400** invalid_request_error |
| 21× `{type:"anthropic", skill_id:"xlsx"}` (dupes) | **400** — "Agent has invalid configuration: duplicate skill_id \"xlsx\"" (NEW rule: **duplicate skill_id rejected**; the 20-cap itself was not cleanly isolated — see open items) |
| skills present + `tools: []` | **200 — accepted** at agent-create (the read-tool coupling is NOT enforced here — see probe 57 for where it lives) |

## Lifecycle (verified)

Delete-only. `DELETE /v1/skills/{id}` while versions exist → **400**; delete each
`DELETE /v1/skills/{id}/versions/{v}` → 200; then `DELETE /v1/skills/{id}` → 200.

## Open items (minor)

1. **20-skills-per-session cap error shape** — unisolated (the dup test tripped
   the duplicate-skill_id rule first). Cap value 20 is documented; exact
   over-cap message needs 21 *distinct* skill_ids to observe. Low priority.
2. GetSkill/ListSkills exact pagination bounds beyond one page — not exercised.
