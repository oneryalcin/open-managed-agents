# CMA Agent Update and Immutable Versioning

Date: 2026-07-14
Status: implemented in PR #186; review pending
Evidence: hosted probe 67 plus the cached CMA `agent-setup` and `sessions`
documentation

## 1. Outcome

Add the missing agent-iteration workflow without weakening session
reproducibility:

- `POST /v1/agents/{id}` updates an active agent from an explicitly expected
  version;
- configuration-changing updates create immutable integer revisions;
- `GET /v1/agents/{id}?version=N` retrieves a historical revision;
- `GET /v1/agents/{id}/versions` lists revisions newest-first;
- a bare agent ID selects the latest revision at session creation, while an
  explicit version selects that exact revision;
- every runtime consumer resolves the session's pinned revision rather than
  the agent's current head.

The last item is load-bearing. Today the session row stores `agent_version`,
but the builtin/custom/MCP runtime resolvers read `retrieveAny()` and therefore
would silently follow the latest agent after updates
(`sessions/pi/tool-permissions.ts:495-505`, `sessions/pi/mcp/bridge.ts:431-495`,
`control-plane/wiring.ts:103-120`). Version storage alone would produce an API
that looks reproducible while execution is not.

## 2. Evidence contract

### Observed in probe 67 `[Obs]`

- A successful update from expected version N creates version N+1.
- A stale expected version returns HTTP 409 `invalid_request_error` with:
  `Concurrent modification detected. Please fetch the latest version and retry.`
- A failed stale update does not consume a version number.
- Omitted fields remain unchanged.
- Explicit `null` clears nullable `description` and `system`.
- Metadata is patched by key: strings add/replace, null deletes, omitted keys
  remain.
- Latest retrieval returns the head; historical retrieval returns immutable
  configuration under the same agent ID.
- Missing historical retrieval returns HTTP 404 `not_found_error` with
  `Agent version not found.`
- Version listing returns exactly `{data,next_page}`, newest-first.
- A bare agent ID selects latest for a new session; an explicit version pins
  that version. A missing explicit version returns HTTP 404 with
  `agent.version: <N> not found`.
- Archived agents cannot be updated (`400`, `Cannot modify archived agent`),
  but latest/historical retrieval and version listing remain available.
- `archived_at` is shared lifecycle state and appears on historical responses.

Sources: `scratch/67-managed-agents-agent-versioning-probe.md` and
`scratch/artifacts/67-managed-agents-agent-versioning-probe.json`.

### Documented by CMA `[Doc]`

The cached CMA documentation additionally defines:

- scalar replacement for `name`, `model`, `system`, and `description`;
- full replacement for `tools`, `mcp_servers`, and `skills`, with null or an
  empty array clearing an array field;
- whole-value replacement for `multiagent`;
- no-op detection: an update producing no configuration change returns the
  existing version rather than allocating another revision.

Source: `/tmp/claude-docs/docs/managed-agents/agent-setup.md:196-313`.

### Explicitly not established

Do not claim hosted parity for:

- the winner ordering of truly simultaneous update requests;
- unknown request-field handling or every field-specific validation message;
- `metadata: null` semantics;
- update-after-archive precedence when the expected version is also stale;
- the exact cursor encoding used by hosted;
- coordinator roster repinning (OMA rejects non-null `multiagent` until the
  coordinator runtime exists);
- `agent_with_overrides` session inputs and session-local update behavior,
  which remain a separately deferred session-parity surface.

OMA will preserve its existing validation rules for updated values and its
single-node deployment model. These choices must be labeled as OMA behavior in
tests and docs rather than presented as hosted observations.

## 3. Current seams

- `src/control-plane/agents/store.ts:10-30` stores identity, current
  configuration, lifecycle, and the single version number in one `agents` row.
- `src/control-plane/agents/service.ts:52-79` always creates version 1;
  `:103-137` exposes only retrieve/archive/list.
- `src/control-plane/agents/routes.ts:10-44` has no update, historical retrieve,
  or version-list route.
- `src/types/agents.ts:79-107` has create/response types but no update request or
  versions-page type.
- `src/control-plane/sessions/service.ts:358-373` resolves only the head and
  rejects every explicit version except the head.
- `src/control-plane/sessions/store.ts:173-177` already persists the resolved
  `agent_version`, so the durable session identity seam exists.
- Runtime store-backed resolvers use the agent ID but not the session's version
  (`src/control-plane/wiring.ts:103-120`,
  `src/control-plane/sessions/pi/tool-permissions.ts:495-505`, and
  `src/control-plane/sessions/pi/mcp/bridge.ts:431-495`).
- `PiSessionRunner` currently retains only an agent ID during pre-commit setup
  (`src/control-plane/sessions/pi/runner.ts:239-267`) and selects its model from
  deployment defaults rather than the agent revision (`:979-1023`).
- Agent parsing accepts any non-empty model ID, while Pi resolves models inside
  a deployment provider namespace. Switching execution to the revision model
  without an explicit availability boundary would turn previously ignored
  values into late runtime failures.

## 4. Design decisions

### D1 — Keep `agents` as the materialized head; add `agent_versions`

Do not rewrite the existing table into a new owner/version graph. Keep
`agents` as the current-head and lifecycle row so existing list, archive, and
deployment code stay small. Add an immutable `agent_versions` table containing
one complete configuration snapshot per `(workspace_id, agent_id, version)`:

```text
workspace_id, agent_id, version,
name, model, system, description,
tools, skills, mcp_servers, metadata, multiagent,
created_at, updated_at
```

`archived_at` does not belong in revision rows. Historical serialization reads
the owner/head row's current `archived_at` and overlays it on the immutable
revision, matching probe 67.

Create writes both the head row and revision 1 in one SQLite transaction.
Update writes the next revision and advances the materialized head in one
transaction. No revision endpoint deletes or mutates history.

### D2 — Backfill existing databases at store initialization

After creating `agent_versions`, run an idempotent
`INSERT OR IGNORE ... SELECT ... FROM agents` inside a transaction. Every
pre-feature agent is version 1, so its existing row becomes revision 1 without
changing IDs, sessions, or list behavior.

Add a migration test that constructs the old `agents` schema manually, inserts
an agent and a session pinned to version 1, opens the new stores, and proves
latest/historical retrieval and session resolution still work after restart.

### D3 — Optimistic update is one synchronous transaction

The service parses a patch against the current head, validates the resulting
complete configuration, and submits an expected version plus complete next
row to the store. The store transaction rechecks:

1. agent exists in the workspace;
2. agent is not archived;
3. current version equals the expected version;
4. the new revision number is exactly current+1;
5. head update and revision insert both succeed.

Any failure rolls back. A stale version maps to the probe-67 409 message and
does not consume a number. This is sufficient under the appliance's enforced
single-process database ownership; the version predicate remains a real CAS
guard rather than relying only on the earlier service read.

No-op detection happens after canonical normalization and metadata merge. If
the complete configuration equals the head, return the existing head without
writing or incrementing the version `[Doc]`.

### D4 — Patch semantics reuse create validation

Add a distinct update request type with required positive integer `version`
and optional mutable fields. Preserve absence vs explicit null:

- omitted field: retain the head value;
- `system`/`description: null`: clear;
- `tools`/`skills`/`mcp_servers: null`: replace with `[]` `[Doc]`;
- `metadata`: merge string/null entries by key; reject `metadata: null` as an
  explicit OMA choice until hosted behavior is observed;
- `name`/`model`: cannot be null;
- explicit non-null `multiagent`: retain the existing deployment-level 400;
  null clears it; omission preserves a legacy stored value.

Validate the final merged configuration, not fields independently. In
particular, tool/MCP cross-references, skill-version existence, and model
availability must be checked after applying the patch. Refactor the existing
field parsers only as needed so create and update cannot drift on tool, skill,
MCP, model, and multiagent admission.

Model IDs are interpreted inside the configured deployment provider namespace
(the same `provider` currently used by `PiSessionRunner`); the CMA model object
does not select a provider. Introduce an explicit injected
`AgentModelAvailability` capability, backed in production by Pi's
`ModelRegistry.find(provider, modelId)`. `find()` establishes catalog
registration only; it does **not** prove that provider credentials are currently
configured or valid. Authentication is a separate, potentially transient
runtime concern and must not make durable agent create/update admission depend
on ambient credential availability.

Production composition must create one shared model-catalog owner, including
Pi's paired `AuthStorage`/`ModelRegistry`, and pass the same `ModelRegistry`
instance (and provider namespace) to both the admission capability and
`PiSessionRunner`; the runner also receives that owner's paired `AuthStorage`.
Do not let each side construct an independent
registry: custom-model registration or catalog refresh could otherwise make
admission and execution disagree. Refactor the runner's currently private
field construction into an injected production dependency. A standalone
runner may construct a private default only in tests/internal use where no
agent-backed production admission path exists. Require the admission capability
at production composition for agent create/update and session admission rather
than inspecting optional methods at call time. Unit-only service fixtures may
inject a deterministic accept-all or finite-set fake.

Create and update reject an unavailable final model before persistence with a
stable OMA `invalid_request_error`, e.g.
`Model <id> is not available on this deployment`. Session creation revalidates
the pinned revision before any session row, snapshots, mounts, or runtime setup
is created. This second check covers migrated rows and deployment/provider
changes after agent creation. It uses the same error contract. Never fall back
to the deployment default: that would make persisted version identity disagree
with execution.

### D5 — Historical retrieval overlays shared lifecycle state

Add `AgentStore.retrieveVersion(workspaceId, agentId, version)` and service
support for an optional retrieval version.

- no version: return materialized head, active or archived;
- explicit version: return immutable revision with the current owner's
  `archived_at`;
- missing owner: preserve the existing OMA missing-agent response;
- existing owner but missing revision: return probe-67
  `Agent version not found.`.

Do not modify historical configuration during archive. Archive remains an
idempotent update of the owner/head lifecycle row only.

### D6 — Version listing is newest-first and agent-bound

Add `AgentStore.listVersions()` and the exact public envelope
`{data,next_page}` (no `has_more`). Query `version < anchor`, order by version
descending, request `limit+1`, and return at most the normalized limit.

The cursor encoding is OMA-owned, but it must be opaque, canonical, scoped to
workspace+agent, and tamper-evident. Use the same instance-lifetime HMAC model
already proven for session pagination, with a distinct domain separator and an
agent-store-owned random key. Tests must reject malformed, modified,
cross-agent, and cross-workspace cursors. Recreating the `SqliteAgentStore`
invalidates outstanding cursors; document that explicitly.

### D7 — Session creation resolves an exact revision

Replace the current head-equality check in
`sessions/service.ts:358-373`:

- bare ID -> retrieve current head;
- explicit version -> retrieve that immutable revision;
- missing explicit version -> probe-67 404/message;
- archived owner -> retain the existing no-new-session rejection.

Use the resolved revision for read-tool admission, skill resolution/snapshot,
and the persisted `session.agent.version`. A later agent update must not affect
the created session.

### D8 — Every runtime lookup follows the session version

Extend creation-time runtime context from `{agentId}` to
`{agentId, agentVersion}`. On restart/eviction, read both from the persisted
session row. Change the following providers to call `retrieveVersion`:

- custom tool definitions (`control-plane/wiring.ts`);
- builtin tool permissions (`sessions/pi/tool-permissions.ts`);
- MCP server declarations and MCP tool permissions
  (`sessions/pi/mcp/bridge.ts`).

Fail closed if the pinned revision cannot be resolved.

Also resolve the agent revision when constructing the Pi handle:

- resolve `agent.model.id` under the configured deployment provider and select
  that exact registry model instead of the runner fallback;
- provide a non-null `agent.system` through the real Pi 0.80.6
  `DefaultResourceLoader.systemPrompt` seam;
- preserve current fallback behavior only for tests/internal runners that
  intentionally provide no agent context. A production session carrying an
  agent revision must never fall back.

For a durable session that predates this admission rule, or whose configured
provider/model disappears after a deployment change, warm-handle recreation
fails closed before model invocation or tool/MCP setup. The existing runtime
turn error boundary records a terminal session error; no alternate model is
selected. Add a regression for this restart case as well as the new-session API
rejection.

The model `speed` tier remains stored/wire-visible but is not mapped to a
separate self-hosted execution class in this slice.

### D9 — Keep the session response expansion out of this slice

OMA currently returns the compact `{type,id,version}` session agent reference
(`src/types/sessions.ts:7-19`, `sessions/serialize.ts:4-26`), while probe 67
shows hosted returns the resolved configuration inside the session object.
Changing every session create/retrieve/list/archive/idempotency response is a
separate cross-cutting wire migration. Record it in `PARITY.md`, but do not mix
it into the storage/runtime correctness work here.

The acceptance bar for this slice is that the stored version number and actual
execution configuration agree. The richer session response can follow without
changing that invariant.

## 5. API surface

Add:

```text
POST /v1/agents/{id}
GET  /v1/agents/{id}?version=N
GET  /v1/agents/{id}/versions?limit=N&page=CURSOR
```

Route parsing requirements:

- update body must be valid JSON and contain a positive integer `version`;
- retrieval `version`, when present, must be a positive integer;
- versions `limit` uses the shared positive-integer parser and the store caps
  at 100;
- empty `page` is treated consistently with other public routes (omitted at the
  route boundary), while malformed non-empty cursors return 400.

Extend `AgentService` and `AgentStore` interfaces rather than reaching around
them from routes.

## 6. Implementation slices

### Slice 1 — Storage and migration

- Add `agent_versions`, initialization backfill, serialization helpers, and
  atomic create/update primitives in `agents/store.ts`.
- Add store tests for create dual-write, update rollback/CAS, no gaps, immutable
  rows, archive overlay, workspace isolation, and old-schema restart migration.

### Slice 2 — Agent API and patch semantics

- Add request/page types in `src/types/agents.ts` and agent domain interfaces.
- Add update parsing/merge/final-state validation in `agents/service.ts`.
- Add one shared production model-catalog owner; inject its exact registry and
  provider namespace into both `PiSessionRunner` and the explicit
  deployment-provider model-availability capability used by agent/session
  admission.
- Add update, historical retrieve, and version-list routes.
- Pin the 409, archived-update, missing-version, metadata-patch, null-clear,
  no-op, unavailable-model, and `{data,next_page}` contracts with full response
  equality.

### Slice 3 — Session selection and runtime pinning

- Resolve exact revisions at session creation.
- Carry version through pre-commit runner context and post-restart providers.
- Move custom/builtin/MCP resolvers to exact revision lookup.
- Select the revision model/system when creating a real Pi session.
- Add warm-handle, eviction/restart, and update-after-session regressions proving
  an existing session remains on v1 while a later bare-ID session uses v2.

### Slice 4 — Live parity smoke and docs

- With an OMA-owned test agent, create v1, update to v2, create one pinned-v1
  and one latest session, and prove the real runtime receives distinct
  system/model/tool configuration as intended.
- Verify stale update, historical retrieve, version listing, and archive
  behavior through HTTP.
- Update `PARITY.md`, `handoff.md`, and API-facing docs; record the richer
  session-agent response as a named follow-up rather than implying it shipped.

## 7. Acceptance criteria

1. Existing durable databases open without manual migration and expose their
   old agents as revision 1.
2. Create persists head+revision atomically; update persists new head+revision
   atomically; injected failure leaves neither a partial head nor a partial
   revision.
3. Valid update N returns N+1; stale N returns the exact probe-67 409 and the
   next successful update still allocates only N+1.
4. Omitted, null, array replacement, metadata patch, and no-op semantics match
   the `[Obs]`/`[Doc]` rules above.
5. Historical retrieval remains byte-for-byte stable in configuration after
   later updates and after archive; only shared `archived_at` changes.
6. Version listing returns only `{data,next_page}`, newest-first, with stable
   pagination and agent/workspace-bound tamper rejection.
7. Bare-ID session creation pins the current head; explicit version creation
   pins that exact revision; missing explicit versions return probe-67 404.
8. After v1 session creation and v2 agent update, v1 session custom tools,
   builtin permissions, MCP declarations/access, skills, model, and system
   remain v1 across warm reuse and runner restart/eviction.
9. Agent create/update and session creation reject a model unregistered under
   the configured deployment provider before durable side effects, using the
   same registry instance that the runner executes against. Missing/transient
   credentials do not masquerade as catalog rejection. A migrated durable
   session whose pinned model later becomes unavailable fails closed on handle
   recreation and never uses the deployment fallback.
10. A new bare-ID session after the update receives v2; an explicit v1 session
    still receives v1.
11. Archived agents remain retrievable/listable by version but reject updates
    and new sessions.
12. Full suite, focused store/API/runtime tests, typecheck, and
    `git diff --check` pass.

## 8. Risks and mitigations

- **Head/history divergence:** dual-write only inside one transaction; migration
  and injected-failure tests.
- **Latest-row leakage into old sessions:** exact-version provider interface and
  warm/restart regressions across every runtime resolver.
- **Parser drift between create/update:** reuse canonical field parsers and
  validate the complete merged configuration.
- **Unavailable or provider-ambiguous models:** interpret IDs under the explicit
  deployment provider; share one registry instance between admission and the
  runner; treat catalog registration separately from credential health;
  revalidate before session side effects; and fail closed during durable-handle
  recreation without fallback.
- **Cursor replay/tampering:** store-instance HMAC scoped to workspace+agent;
  explicit lifecycle documentation.
- **Archived lifecycle copied into history:** keep lifecycle only on owner/head
  and overlay during serialization.
- **Scope expansion into session response parity:** track separately per D9;
  do not alter every session envelope in this arc.

## 9. Verification commands

Use the repository's actual scripts, with focused tests first:

```bash
npm test -- src/control-plane/agents/__tests__/service-store.test.ts \
  src/control-plane/__tests__/agents-api.test.ts \
  src/control-plane/sessions/__tests__/service-store.test.ts \
  src/control-plane/sessions/pi/__tests__/runner.test.ts \
  src/control-plane/sessions/pi/__tests__/runner-custom-tools.test.ts \
  src/control-plane/sessions/pi/mcp/__tests__/bridge.test.ts
npm run typecheck
npm test
git diff --check
```

The implementation is complete only when the mutation test “replace an exact
revision lookup with latest lookup” fails at least one runtime pinning test.

## 10. Source anchors

- Hosted evidence: `scratch/67-managed-agents-agent-versioning-probe.md`
- Raw redacted artifact:
  `scratch/artifacts/67-managed-agents-agent-versioning-probe.json`
- Hosted docs: `/tmp/claude-docs/docs/managed-agents/agent-setup.md:196-387`
- Agent types/store/service/routes: `src/types/agents.ts`,
  `src/control-plane/agents/{types,store,service,routes}.ts`
- Session resolution: `src/control-plane/sessions/service.ts:353-445`
- Session durable pin: `src/control-plane/sessions/store.ts:173-177`
- Runtime agent lookups: `src/control-plane/wiring.ts:103-120`,
  `src/control-plane/sessions/pi/tool-permissions.ts:495-505`,
  `src/control-plane/sessions/pi/mcp/bridge.ts:431-495`
- Pi 0.80.6 model/system seams:
  `node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts:11-57` and
  `dist/core/resource-loader.d.ts:65-112`
- Current deployment-provider/model lookup:
  `src/control-plane/sessions/pi/runner.ts:979-995`
