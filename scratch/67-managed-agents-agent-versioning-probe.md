# Probe 67 — hosted agent updates and immutable versions

Date: 2026-07-13
Status: complete
Artifact: `scratch/artifacts/67-managed-agents-agent-versioning-probe.json`

## Method

The probe created one hosted agent at version 1, performed two successful
updates, attempted a stale update, retrieved current and historical versions,
paginated version history, created sessions from both the bare agent ID and an
explicit historical version, then archived the agent and repeated retrieval,
version listing, and update operations. One cloud environment and two idle
sessions were created for version-selection checks. All resources were deleted
or archived afterward.

The script reads `ANTHROPIC_API_KEY` directly from
`/Users/oner/dev/junk/cwc-workshops/.env`. Durable resource IDs and opaque
cursors are pseudonymized in the artifact.

Run:

```bash
uv run --with anthropic python scratch/67-managed-agents-agent-versioning-probe.py
```

## Findings

### Update and optimistic concurrency

- `agents.update(agent_id, version=N, ...)` treats `version` as the expected
  current version. Updating version 1 produced version 2; updating version 2
  produced version 3.
- Reusing stale expected version 1 after version 2 existed returned HTTP 409
  with error type `invalid_request_error` and message:
  `Concurrent modification detected. Please fetch the latest version and retry.`
- The rejected stale update did not consume a version: the next valid update
  produced version 3.
- Omitted fields are retained. Explicit nullable fields clear values:
  `description=None` and `system=None` became null.
- Metadata updates are patch-like: string values add/replace keys and null
  values remove keys. Omitted metadata keys remain unchanged.
- Successful update responses use the ordinary agent representation and carry
  the newly allocated version.

### Immutable revisions and retrieval

- Retrieving an agent without `version` returns the latest revision.
- `retrieve(..., version=1)` and `version=2` returned their original names,
  descriptions, systems, and metadata after version 3 existed.
- A missing historical version returned HTTP 404 `not_found_error` with
  `Agent version not found.`
- Version identity is one agent ID plus an integer revision; updates do not mint
  a new agent ID.

### Version history

- `agents.versions.list` returns `{data,next_page}`.
- Versions are newest-first: with versions 1–3 and `limit=2`, page 1 contained
  `[3,2]` and page 2 contained `[1]`.
- The terminal page has `next_page: null`.

### Session version selection

- Creating a session with the bare agent ID selected the latest version (3).
- Creating with `{type:"agent", id, version:1}` pinned the complete version-1
  configuration into the session.
- Requesting nonexistent version 999 returned HTTP 404 `not_found_error` with
  `agent.version: 999 not found`.

### Archive interaction

- Archiving retained the latest version number and configuration and populated
  `archived_at`.
- Updating an archived agent returned HTTP 400 `invalid_request_error` with
  `Cannot modify archived agent`.
- Latest and historical retrieval remained available after archive.
- Version listing remained available after archive and returned `[3,2,1]`.
- Archived state appears as shared agent lifecycle state: historical retrievals
  also reported a populated `archived_at`, while their revision configuration
  remained historical.

## Evidence boundaries

This probe did not establish concurrent winner/loser behavior from truly
simultaneous requests, no-op update behavior, session creation after archive,
or every field-specific validation rule for model/tools/skills/MCP/multiagent.
Those should not be invented in the implementation plan. The SDK surface marks
`version` required and exposes the mutable update fields, but SDK typing alone
is documentation evidence rather than observed wire behavior.
