# 69 — CMA environment lifecycle probe

Run date: 2026-07-20. Runner: `scratch/69-managed-agents-environment-lifecycle-probe.py` with the official Anthropic Python SDK and a credential supplied outside this repository. The script creates only disposable resources, redacts request IDs, and cleans them up.

## Observed contract

| Operation | Hosted CMA result |
| --- | --- |
| `POST /v1/environments/{id}/archive` | Returns the environment with `state: "archived"` and `archived_at` populated. |
| Repeat archive | Idempotent; returns the same archived environment. |
| Retrieve archived environment | Succeeds. |
| List default | Excludes archived environments. |
| List with `include_archived=true` | Includes archived environments. |
| Existing idle session after archive | Remains retrievable. |
| Create session with archived environment | `400 invalid_request_error`: `Environment env_<redacted> is archived.` |
| Delete unreferenced environment | Returns `{ "type": "environment_deleted", "id": "env_<redacted>" }`; subsequent retrieve is a `404 not_found_error`. |

## Important delete discrepancy

The current downloaded CMA documentation says deletion is allowed only when no sessions reference the environment. The live probe instead successfully deleted both an archived and an active environment that each had an idle referencing session; those sessions remained retrievable.

OMA intentionally does **not** copy that observed behavior in #206. A persisted OMA session reconstructs its sandbox/egress configuration from the environment record at runtime. Deleting a referenced environment would leave a durable session unable to reconstruct its environment. OMA therefore rejects deletion while any session references the environment, and documents this as a deliberate self-hosted safety divergence.
