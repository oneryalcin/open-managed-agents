# 0139 — Pi-backed multi-provider models

Status: implementation-ready plan; implementation not started.

Branch: `dev/pi-multi-provider-models-plan`

## 1. Goal

Make this alpha promise true without rebuilding Pi's provider layer inside
OMA:

> OMA exposes the providers and models supported by its pinned Pi release,
> including operator-defined OpenAI-, Anthropic-, and Google-compatible
> endpoints. Availability depends on operator policy and configured
> credentials.

Today Pi already knows hundreds of models and many authentication mechanisms,
but OMA binds one `provider` string to the whole deployment. The default is
`anthropic` (`sessions/pi/runner.ts:159-171`), agent model records contain only
`{id,speed}` (`types/agents.ts:3-15`), admission checks only
`find(catalog.provider, modelId)` (`app.ts:594-604`), and runtime resolution
repeats the same deployment-wide provider lookup (`runner.ts:708-716`,
`1038-1043`). Setting `OPENAI_API_KEY` or adding a Pi custom model therefore
does not currently make that model selectable by an OMA agent.

The implementation must preserve CMA-compatible Anthropic requests while
adding an explicit OMA provider extension, persist the exact provider/model on
every immutable agent revision, use one shared Pi registry for admission and
execution, and give users a discoverable CLI/API/console path instead of asking
them to guess provider and model IDs.

## 2. Non-goals

This arc does **not**:

- implement model APIs, streaming transports, OAuth refresh, compatibility
  flags, pricing metadata, or model catalogs that Pi already owns;
- let workspace API callers register providers, change base URLs, supply
  headers, upload `models.json`, or execute provider extensions in the control
  plane;
- load arbitrary Pi extensions to obtain non-standard provider protocols;
- promise that every model in Pi's catalog has been live-tested by OMA;
- validate that credentials are accepted by a remote provider during agent
  creation;
- pin secrets, base URLs, or the full Pi model record into an agent revision;
- silently fall back to another provider or model when the selected pair is
  unavailable;
- add per-workspace BYOK or provider billing boundaries; initial credentials
  are appliance/operator configuration;
- change the CMA session-agent response expansion tracked separately in
  `PARITY.md`.

## 3. Principles and invariants

### P1 — Pi is the model engine and catalog owner

Use Pi 0.80.6's `AuthStorage`, `ModelRegistry`, built-in model catalog,
`models.json` parser, request adapters, compatibility flags, and credential
resolution. OMA must not copy Pi's model list into source, SQLite, or frontend
constants.

### P2 — OMA owns policy and durable identity

OMA owns:

- the operator allowlist of providers;
- the deployment default provider;
- the durable `{provider,id,speed}` selected by each immutable agent revision;
- fail-closed admission and restart behavior;
- model discovery exposed to workspace users;
- secret-safe operator UX and documentation.

### P3 — Admission and execution share one registry instance

Plan 0133 already requires one production catalog owner. Preserve and extend
that invariant: agent create/update, session admission, warm runtime creation,
and restart-time handle reconstruction must use the exact same `AuthStorage`
and `ModelRegistry` instances. Independent production registries are forbidden.

### P4 — No fallback

If `{provider,id}` is disallowed, unregistered, removed, or unavailable during
handle recreation, fail before selecting any deployment default. A durable
session must never migrate from one provider/model to another by accident.

### P5 — Operator configuration is trusted; workspace input is not

Only the appliance operator can supply auth/config files, provider allowlists,
custom base URLs, headers, or Pi compatibility settings. Workspace users can
select only entries published by OMA's filtered catalog.

### P6 — Credential presence is not credential validity

Pi can establish that auth is configured without making a paid network call.
Agent create/update validates policy and registration only. Session admission
also requires configured auth, but an expired, revoked, rate-limited, or
otherwise invalid credential remains a runtime provider error. Do not reject a
durable agent revision because a credential is temporarily absent or invalid.

## 4. Decisions

### D1 — Extend model identity with `provider`

Change the normalized internal model shape to:

```ts
interface ManagedAgentsModelConfig {
  provider: string;
  id: string;
  speed: "standard" | "fast";
}
```

Accept both existing CMA input and the OMA extension:

```json
{"model":"claude-sonnet-5"}
```

```json
{"model":{"id":"claude-sonnet-5","speed":"standard"}}
```

```json
{"model":{"provider":"openai","id":"gpt-5.4","speed":"standard"}}
```

String and provider-less object input resolve through the configured deployment
default **at create/update time**, then persist the explicit provider. The
initial deployment default remains `anthropic`.

Responses include `model.provider` for all agents. This is a deliberate OMA
extension to the CMA model object, not a replacement endpoint or a
provider-qualified string convention. Add an official Anthropic SDK
compatibility test proving the extra response field does not break the pinned
SDK path used by OMA. If the pinned SDK rejects unknown response fields, do not
encode provider into `id`; instead gate the response extension behind an
OMA-specific beta and document that non-Anthropic models require it. This is an
implementation gate, not permission to silently omit provider.

Why not `openai/gpt-5.4` in `id`: provider and model IDs can themselves contain
slashes, colons, ARNs, and routed names. A second parsing convention would be
ambiguous and duplicate a field Pi already models explicitly.

### D2 — Migrate historical rows to explicit Anthropic identity

The `agents.model` and `agent_versions.model` columns already store JSON text
(`agents/store.ts:14-50`, `196-218`, `222-253`), so no SQL column is needed.
Add an idempotent transaction in `SqliteAgentStore` startup migration:

1. read every head/version model JSON;
2. validate it is the legacy `{id,speed}` shape or the new shape;
3. rewrite only legacy rows as `{provider:"anthropic",id,speed}`;
4. roll back all rewrites if any row is malformed;
5. run the existing head-to-version backfill and model migration in one
   explicitly ordered startup transaction.

Never use the current deployment default for legacy migration. Every historical
OMA model was previously resolved against Anthropic, so `anthropic` is the only
history-preserving value.

Because the project is pre-v1 and has no external users, resetting a development
database remains acceptable. The migration is still worth retaining because it
tests the production invariant needed when this schema is released.

### D3 — Make `PiModelCatalog` a policy-aware wrapper around Pi

Replace the single-provider catalog shape (`runner.ts:159-171`) with a shared
owner similar to:

```ts
interface PiModelCatalog {
  defaultProvider: string;
  allowedProviders: ReadonlySet<string>;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  resolve(ref: { provider?: string; id: string }): Model<any> | undefined;
  list(options?: { provider?: string; availableOnly?: boolean }): Model<any>[];
  authStatus(provider: string): { configured: boolean };
}
```

`resolve()` first normalizes `provider ?? defaultProvider`, then checks the
allowlist, then calls Pi's `ModelRegistry.find(provider,id)`. It never searches
all providers by ID and never falls back.

Create the production owner with explicit OMA paths:

```text
${OMA_HOME:-~/.oma}/pi/auth.json
${OMA_HOME:-~/.oma}/pi/models.json
```

Call `AuthStorage.create(authPath)` and
`ModelRegistry.create(authStorage, modelsPath)`. Do not use Pi's implicit
`~/.pi/agent` paths in production; unrelated interactive Pi credentials or
custom models must not leak into an OMA appliance.

Tests and standalone internal runners may still inject a finite fake catalog.

### D4 — Explicit deployment policy

Add deployment configuration:

```text
OMA_MODEL_PROVIDERS=anthropic,openai,google
OMA_DEFAULT_MODEL_PROVIDER=anthropic
OMA_PI_AUTH_FILE=/optional/operator/path/auth.json
OMA_PI_MODELS_FILE=/optional/operator/path/models.json
```

Rules:

- unset `OMA_MODEL_PROVIDERS` means `anthropic` only;
- trim entries, reject empty names/duplicates, and preserve deterministic order;
- the default provider must appear in the allowlist;
- custom provider names are allowed only when Pi successfully loads them;
- unknown allowed providers fail appliance startup with a precise error;
- paths resolve explicitly and are logged without file contents;
- changing policy/config requires appliance restart in this arc;
- sandbox provider selection remains unrelated.

Do not infer authorization from whichever API keys happen to be in the process
environment. Credentials answer “can Pi authenticate?”; the allowlist answers
“may workspace agents use this provider and incur its cost/data transfer?”

Parse this in a dedicated model-deployment config module rather than extending
the sandbox-only `deployment-runtime-config.ts` vocabulary.

### D5 — Reuse Pi `models.json`, with an OMA security profile

Pi's existing `models.json` format supports Ollama, vLLM, LM Studio, proxies,
provider overrides, and custom models using supported adapters such as:

- `anthropic-messages`;
- `openai-completions`;
- `openai-responses`;
- `azure-openai-responses`;
- `google-generative-ai`.

OMA loads that format unchanged through `ModelRegistry`. Do not define
`oma-models.yaml` or translate it into a second schema.

For alpha, validate the operator file before server construction and reject:

- malformed Pi model config;
- providers not in the OMA allowlist;
- non-HTTPS remote base URLs, except loopback HTTP for explicitly local custom
  providers;
- command-backed `!command` values in `apiKey` or headers unless the operator
  explicitly enables `OMA_ALLOW_MODEL_AUTH_COMMANDS=true`;
- unsupported extension-only/custom stream implementations.

Environment interpolation (`$OPENAI_API_KEY`) and OMA-owned `auth.json` remain
supported through Pi. Literal credentials in `models.json` should produce a
startup warning and documentation guidance, not be returned by any API or log.

Pi provider extensions execute host code and are not loaded by this arc. The
compatible API adapters in `models.json` cover the intended alpha surface.

### D6 — Credential lifecycle is operator-side

Credential resolution remains delegated to Pi. Supported sources include the
OMA-owned Pi `auth.json`, provider configuration in operator-owned
`models.json`, Pi-supported process environment variables, OAuth entries, and
cloud identity mechanisms. OMA must not reproduce or reorder that resolution
logic; contract tests pin the behavior of the installed Pi version.

Add secret-safe CLI commands:

```text
oma providers status
oma models list [--provider NAME] [--available]
oma models validate [--file PATH]
oma auth set PROVIDER [--stdin]
oma auth remove PROVIDER
oma auth status [PROVIDER]
```

Requirements:

- `oma auth set` prompts without echo by default;
- never accept a plaintext key as a command-line argument;
- `--stdin` reads exactly one credential value for automation;
- writes and removals call Pi's `AuthStorage.set/remove` rather than editing its
  JSON format independently; verify the backing store's lock/atomicity behavior
  and add an OMA wrapper only if the installed Pi implementation cannot meet
  the required durability contract;
- directory mode is `0700`, file mode is `0600`;
- refuse unsafe existing permissions until corrected;
- preserve unrelated provider credentials when updating one provider;
- never print the credential after storage;
- removal requires an exact provider name and is idempotent;
- OAuth subscription login is deferred; `status` may report existing Pi OAuth
  credentials if an operator deliberately supplied an auth file;
- command-backed credentials are never created by this CLI.

`oma up` passes the resolved OMA paths/policy to the control plane. The CLI and
server must call the same catalog factory so validation cannot drift.

### D7 — Workspace-safe discovery API

Add OMA extension route:

```text
GET /v1/models
```

It requires workspace authentication and the managed-agents beta header. It is
documented under `Models (OMA)` in OpenAPI. Query parameters:

```text
provider=<exact provider name>
available=true|false   # default false; false means registered + allowed
limit=1..100           # default 50
page=<opaque cursor>
```

Response uses the forward page shape:

```json
{
  "data": [
    {
      "type": "model",
      "provider": "openai",
      "id": "gpt-5.4",
      "name": "GPT-5.4",
      "reasoning": true,
      "input": ["text", "image"],
      "context_window": 400000,
      "max_output_tokens": 128000,
      "credentials_configured": true,
      "default": false
    }
  ],
  "next_page": null
}
```

Do not expose base URLs, headers, credential source names,
account/project IDs, file paths, costs, raw Pi compat objects, or secrets.
`ModelRegistry` returns a merged catalog and does not expose stable provenance,
so OMA must not reparse configuration merely to invent a `source` field.
Provider display names can be added only from Pi's public display-name helper.

Cursor/filter binding must follow the authenticated cursor pattern already used
for agent-version/session pagination. Stable ordering is `(provider,id)`.

The endpoint reports catalog/readiness state; it does not mutate credentials or
providers.

### D8 — Admission behavior

Change `AgentModelAvailability.assertAvailable(modelId)`
(`agents/service.ts:53-72`) to accept the normalized model reference.

Agent create/update:

1. normalize provider using the deployment default;
2. reject a provider outside the allowlist;
3. reject a pair absent from Pi's registry;
4. persist the explicit pair before any agent/version writes;
5. do **not** require currently valid credentials.

Stable OMA errors:

```text
Model provider <provider> is not enabled on this deployment
Model <provider>/<id> is not available on this deployment
```

Session create (`sessions/service.ts:358-380`) and durable handle recreation:

1. resolve the exact persisted pair;
2. reject if provider policy or registry changed;
3. reject before session rows, snapshots, mounts, or runtime state when Pi
   reports no configured auth;
4. never substitute the default provider/model.

Missing-auth error:

```text
Credentials for model provider <provider> are not configured on this deployment
```

This is a readiness check, not remote credential validation. Remote auth errors
continue through the existing model-error/event path.

### D9 — Runtime exact-version resolution

Update the store-backed agent revision provider and runner types so every warm
and restart path carries `{provider,id}` (`runner.ts:205-213`, `701-716`,
`1032-1043`). Use `modelRegistry.find(revision.model.provider,
revision.model.id)` directly.

Tests must mutation-prove that deleting the provider lookup, replacing it with
the default provider, searching by ID only, or falling back to `opts.model`
causes failures.

Do not persist Pi's complete model object. Provider endpoints, credentials, and
compatibility fixes are operational configuration and may rotate. Persisting
the exact pair gives identity/reproducibility without freezing secrets or stale
transport definitions. If a model is removed, existing sessions fail closed.

### D10 — Console model selection

Replace the hardcoded `MODELS` datalist (`console/forms.jsx:177-246`) with live
`GET /v1/models` data:

- provider selector first;
- searchable model selector second;
- default to the deployment default provider/model only when returned by the
  server;
- visually distinguish configured vs missing credentials;
- allow creating an agent with missing credentials, but show that session
  creation will be unavailable until the operator configures them;
- send `{provider,id}` for non-default selections;
- render provider beside model in agent list/detail (`console/api.js:405-420`);
- if catalog loading fails, show a real error and do not fall back to a
  hardcoded/demo model list in live mode;
- demo mode may retain static examples, clearly labeled as demo data.

The console never receives or writes provider credentials.

### D11 — Support tiers and documentation

Document three tiers:

1. **OMA-verified** — provider/model families exercised by OMA live smokes;
2. **Pi-supported** — present in the pinned Pi catalog and available when
   operator policy/auth permit it, but not independently certified by OMA;
3. **Operator-defined** — custom compatible endpoints loaded through Pi's
   `models.json`, advanced/experimental until the operator verifies them.

Initial live verification targets, when credentials are available:

- Anthropic;
- OpenAI;
- Google Gemini;
- OpenRouter.

Do not make these secrets mandatory in ordinary CI. Each live lane is gated and
records provider, model, result, Pi version, and redacted failure class.

Update the README quickstart so Anthropic is the default example, not a product
requirement.

## 5. Implementation slices

### Slice 1 — Durable provider identity and migration

Files:

- `src/types/agents.ts`
- `src/control-plane/agents/types.ts`
- `src/control-plane/agents/service.ts`
- `src/control-plane/agents/store.ts`
- agent store/service/API tests
- OpenAPI agent schemas

Deliver:

- provider-aware input/output types;
- default-provider normalization;
- explicit provider persistence in heads and immutable versions;
- atomic legacy migration to Anthropic;
- create/update/history/no-op behavior pinned;
- SDK compatibility gate for response extension.

This slice uses a finite fake availability capability. It does not change
production Pi configuration yet.

### Slice 2 — Shared Pi catalog, policy, and runtime

Files:

- `src/control-plane/sessions/pi/runner.ts`
- new `src/control-plane/models/catalog.ts`
- new `src/control-plane/models/deployment-config.ts`
- `src/control-plane/app.ts`
- `src/control-plane/sessions/service.ts`
- store-backed agent revision provider and runner tests
- deployment configuration tests

Deliver:

- OMA-owned Pi config paths;
- provider allowlist/default parsing;
- one shared registry/auth owner;
- exact-pair admission and runtime resolution;
- configured-auth session gate;
- restart/warm-handle no-fallback proof;
- custom `models.json` validation/security profile.

### Slice 3 — Discovery API and CLI

Files:

- new `src/control-plane/models/routes.ts`
- new `src/control-plane/models/service.ts`
- `src/control-plane/app.ts`
- `src/control-plane/openapi/document.ts`
- `bin/oma.mjs`
- focused route/CLI/OpenAPI tests

Deliver:

- paginated workspace-safe model discovery;
- secret-free provider/model status;
- `oma providers`, `oma models`, and `oma auth` commands;
- atomic `0600` auth storage;
- shared catalog validation path;
- no HTTP credential mutation.

### Slice 4 — Console and onboarding

Files:

- `ui/managed-agents-console/src/api.js`
- `ui/managed-agents-console/src/forms.jsx`
- `ui/managed-agents-console/src/agents-files.jsx`
- console tests
- `README.md`
- `docs/dev-deployment.md`
- `docs/tutorials/docker-local-first-run.md`
- `ALPHA.md`, `PARITY.md`, `handoff.md`

Deliver:

- live provider/model selection;
- readiness states;
- multi-provider quickstart examples;
- custom compatible endpoint example using Pi's format;
- explicit support tiers and known limitations.

### Slice 5 — Verification matrix and alpha gate

Files:

- `scripts/alpha-smoke.mjs`
- model smoke fixtures/scripts under `scratch/` only when evidence must be
  retained
- CI/gated smoke configuration as appropriate

Deliver:

- `OMA_ALPHA_MODEL_PROVIDER` plus existing `OMA_ALPHA_MODEL`;
- one local custom OpenAI-compatible fixture proving operator-defined model
  routing without a paid external call;
- gated live Anthropic/OpenAI/Google/OpenRouter lanes;
- final clean-checkout alpha audit with at least one non-Anthropic provider.

## 6. Test plan

### Unit

- model parser accepts string, provider-less object, and provider object;
- parser rejects empty/unknown fields, malformed provider, and invalid speed;
- default provider is materialized once and persisted;
- legacy model JSON migrates to Anthropic, idempotently;
- migration rollback on one malformed row leaves every row untouched;
- allowlist/default parsing rejects empty, duplicate, unknown, and inconsistent
  configurations;
- catalog resolves only allowed exact pairs;
- catalog never searches across providers by model ID;
- auth-status mapping reveals no secret/source details;
- custom model validator covers HTTPS, loopback HTTP, command expressions,
  literal-key warnings, and malformed Pi config;
- CLI auth writes atomically with `0600`, preserves peers, and prints no key.

### Integration/API

- create/update agent with default Anthropic provider;
- create/update non-Anthropic agent with explicit provider;
- immutable version history retains different provider/model pairs;
- no-op comparison includes provider;
- disallowed provider and unknown pair reject with zero durable writes;
- missing credentials do not block agent create/update;
- missing credentials block session creation before rows/snapshots/runtime;
- provider removed after agent creation causes session rejection;
- provider/model removed after durable session creation causes restart-time
  fail-closed behavior;
- warm handle and restart both use the pinned revision pair;
- no default fallback mutation survives;
- `/v1/models` filters, pagination, auth, beta, order, cursor binding, and
  redaction;
- OpenAPI route/spec completeness remains green;
- official SDK create/get/list path tolerates the model provider extension.

### Pi contract

Use real Pi 0.80.6 `AuthStorage`/`ModelRegistry` with temporary files to prove:

- built-in provider discovery;
- environment credential readiness;
- OMA-owned auth file precedence;
- custom OpenAI-compatible and Anthropic-compatible entries;
- custom base URL and compat fields reach the resolved Pi model;
- malformed config fails startup rather than silently dropping custom models;
- registry instance identity is shared by admission and runner.

### Console

- live catalog populates provider/model controls;
- missing-auth state is visible;
- selected provider is submitted and rendered;
- catalog 401 expires workspace auth;
- catalog 5xx shows an error and never demo models;
- empty allowed catalog has an actionable operator message;
- demo mode stays clearly separate.

### End-to-end

- clean OMA home + Anthropic existing quickstart;
- clean OMA home + OpenAI (or another verified provider);
- operator-defined local OpenAI-compatible fixture;
- exact provider/model appears in internal model-request diagnostics;
- tools, skills, MCP, sandboxing, and event stream remain provider-independent;
- removing auth then recreating a handle fails clearly and does not fall back.

### Security and observability

- API/log/OpenAPI/console snapshots contain no credentials, auth-file paths,
  custom headers, or full base URLs;
- workspace user cannot mutate catalog/auth/provider policy;
- arbitrary `models.json` command expressions are rejected unless explicit
  operator opt-in is present;
- log catalog startup with Pi version, allowed provider names, registered model
  counts, and configured/missing status only;
- count model admission failures by bounded reason/provider label; do not label
  unbounded model IDs in Prometheus metrics.

## 7. Acceptance criteria

The arc is complete only when all are true:

1. Existing Anthropic string-model requests remain functional.
2. A non-Anthropic agent can be created, versioned, session-pinned, restarted,
   and executed through Pi without a fallback path.
3. Every stored agent head/version contains explicit `provider`, `id`, and
   `speed`.
4. Legacy rows migrate to `provider:"anthropic"` transactionally.
5. Production admission and runtime share one Pi catalog/auth owner.
6. OMA loads Pi's built-in catalog and operator `models.json` without copying
   model definitions into OMA source or SQLite.
7. Provider policy is explicit and independent of credential presence.
8. Agent persistence validates registration/policy; session admission validates
   configured auth before side effects.
9. Missing/removed provider/model/auth fails closed and never selects another
   provider/model.
10. Workspace callers can discover allowed models and credential readiness but
    no secrets/config internals.
11. CLI users can inspect providers/models and safely persist/remove API-key
    credentials under OMA-owned paths.
12. Console users select live providers/models rather than a hardcoded list.
13. At least one non-Anthropic and one operator-defined compatible endpoint pass
    end-to-end verification.
14. README/OpenAPI/ALPHA/PARITY describe the support tiers and limitations
    accurately.
15. Targeted tests, full Vitest, typecheck, `git diff --check`, alpha smoke, and
    real Docker provider smoke pass.

## 8. Risks and mitigations

### Risk: “Pi supports it” is mistaken for “OMA certified it”

Mitigation: publish the three support tiers; gate live verification separately;
never call the whole Pi catalog OMA-verified.

### Risk: extra `model.provider` breaks strict CMA SDK parsing

Mitigation: add the official SDK compatibility gate in Slice 1 before runtime
work. Use an explicit OMA beta response extension if required; never overload
model IDs.

### Risk: ambient Pi configuration leaks into OMA

Mitigation: explicit OMA-owned auth/model paths; no production default to
`~/.pi/agent`.

### Risk: custom provider config becomes host code execution

Mitigation: operator-only files, no workspace mutation, no Pi extensions,
command expressions disabled by default, startup validation.

### Risk: provider credentials are shared across workspaces

Mitigation: document appliance-level credentials and operator billing boundary.
Per-workspace BYOK is a separate vault/authorization arc.

### Risk: catalog upgrades remove or change models

Mitigation: pin Pi version, persist exact provider/id, fail closed when removed,
and include catalog-diff review in Pi upgrade procedure. Do not freeze secrets or
transport definitions into revisions.

### Risk: high-cardinality discovery or metrics

Mitigation: paginate `(provider,id)`, cap limits at 100, use bounded provider and
reason labels in metrics, omit model IDs from Prometheus labels.

### Risk: valid credentials are mistaken for configured credentials

Mitigation: call the field `credentials_configured`, never `healthy` or
`validated`; remote failures stay runtime errors.

## 9. Engineer handoff order

1. Land Slice 1 alone and review the wire/migration decision before touching Pi
   runtime.
2. Land Slice 2 with adversarial no-fallback and config-security review.
3. Land Slice 3 with secret-handling/CLI review.
4. Land Slice 4 with browser workflow verification.
5. Land Slice 5 and run the final alpha audit.

Each slice must be independently testable and must leave unsupported behavior
fail-closed. Do not enable console selection or document multi-provider support
before exact runtime resolution and restart tests are green.
