# 0139 — Pi-backed multi-provider models

Status: implementation-ready candidate; implementation not started. Independent
normal and adversarial review blockers folded; focused re-review pending.

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
- redefine CMA's existing `speed` field or promise provider-specific fast-mode
  behavior; this arc preserves and persists it as today, while Pi model
  selection remains the exact `{provider,id}` pair.

## 3. Principles and invariants

### P1 — Pi is the model engine and catalog owner

Use Pi 0.80.6's `AuthStorage`, `ModelRegistry`, built-in model catalog,
`models.json` parser, request adapters, compatibility flags, and credential
resolution. OMA must not copy Pi's model list into source, SQLite, or frontend
constants.

### P2 — OMA owns policy and durable identity

OMA owns:

- the operator allowlist of providers;
- the deployment default provider/model pair used by OMA discovery and console
  onboarding;
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

Pi can establish model-scoped credential readiness without making a paid
network call. The authoritative predicate is
`ModelRegistry.hasConfiguredAuth(resolvedModel)`, not provider-level
`getProviderAuthStatus()`: Pi 0.80.6 can report an environment credential as
`configured:false` in provider status while the resolved model is usable.
Agent create/update validates policy and registration only. Session admission
also requires model-scoped configured auth, but an expired, revoked,
rate-limited, or otherwise invalid credential remains a runtime provider error.
Do not reject a durable agent revision because a credential is temporarily
absent or invalid.

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

String and provider-less object input are the CMA-compatible forms and always
resolve to `anthropic` **at create/update time**, then persist that explicit
provider. They do not change meaning when the operator changes OMA's discovery
or console default. Selecting a non-Anthropic model requires the explicit
`{provider,id}` OMA extension. This preserves existing CMA requests without
creating a deployment-dependent reinterpretation of historical input.

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

`speed` keeps its existing `standard|fast` validation and persistence semantics
but is not part of Pi model lookup. In particular, `fast` does not select a
different non-Anthropic model or transport in this arc; documentation and the
console must not imply otherwise.

### D2 — Migrate historical rows to explicit Anthropic identity

The `agents.model` and `agent_versions.model` columns already store JSON text
(`agents/store.ts:14-50`, `196-218`, `222-253`), so no SQL column is needed.
Add an idempotent transaction in `SqliteAgentStore` startup migration:

1. read every head/version model JSON;
2. validate it is the legacy `{id,speed}` shape or the new shape;
3. rewrite legacy rows already present in both `agents` and `agent_versions` as
   `{provider:"anthropic",id,speed}`;
4. run the existing `INSERT OR IGNORE ... SELECT ... FROM agents`
   head-to-version backfill only after head rows have been normalized, so newly
   inserted version rows copy the explicit provider;
5. assert no legacy-shaped head/version row remains and commit;
6. roll back the migration and backfill together if any row is malformed or any
   step fails.

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
  defaultModel: { provider: string; id: string };
  allowedProviders: ReadonlySet<string>;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  resolve(ref: { provider: string; id: string }): Model<any> | undefined;
  list(options?: { provider?: string; availableOnly?: boolean }): Model<any>[];
  hasConfiguredAuth(model: Model<any>): boolean;
  providerAuthMetadata(provider: string): {
    source?: string;
    label?: string;
  };
}
```

`resolve()` receives an already normalized durable reference, checks the
allowlist, then calls Pi's `ModelRegistry.find(provider,id)`. CMA input
normalization to Anthropic happens at the API/service boundary; the catalog
never guesses a provider, searches all providers by ID, or falls back.

`hasConfiguredAuth(model)` delegates directly to
`ModelRegistry.hasConfiguredAuth(model)` and is the only readiness boolean used
by API discovery and session/runtime admission. `getProviderAuthStatus()` may
feed redacted diagnostic-source metadata, but its `configured` field must never
gate admission or populate `credentials_configured`.

Create the production owner with explicit OMA paths:

```text
${OMA_HOME:-~/.oma}/pi/auth.json
${OMA_HOME:-~/.oma}/pi/models.json
```

After the narrow security/path scan, construct the mandatory OMA atomic backend
for `authPath`, pass it to `AuthStorage.fromStorage(backend)`, fail startup if
`authStorage.drainErrors()` returns any parse/load error, then call
`ModelRegistry.create(authStorage, modelsPath)` and require
`modelRegistry.getError() === undefined`. Do not call
`AuthStorage.create()` or use Pi's implicit `~/.pi/agent` paths in production;
unrelated interactive Pi credentials or custom models must not leak into an OMA
appliance.

Tests and standalone internal runners may still inject a finite fake catalog.

### D4 — Explicit deployment policy

Add deployment configuration:

```text
OMA_MODEL_PROVIDERS=anthropic,openai,google
OMA_DEFAULT_MODEL_PROVIDER=anthropic
OMA_DEFAULT_MODEL=claude-sonnet-5
OMA_PI_AUTH_FILE=/optional/operator/path/auth.json
OMA_PI_MODELS_FILE=/optional/operator/path/models.json
```

Rules:

- unset `OMA_MODEL_PROVIDERS` means `anthropic` only;
- when both default variables are unset, the effective default pair is
  `anthropic/claude-sonnet-5`; setting either variable requires setting both;
- trim entries, reject empty names/duplicates, and preserve deterministic order;
- the default provider must appear in the allowlist;
- `OMA_DEFAULT_MODEL_PROVIDER` and `OMA_DEFAULT_MODEL` form one required pair;
- the default pair must resolve exactly in the loaded Pi registry at startup;
- custom provider names are allowed only when Pi successfully loads them;
- provider identifiers are trimmed but otherwise exact and case-sensitive; do
  not lowercase or alias them, and reject case-mismatched names as unknown;
- unknown allowed providers fail appliance startup with a precise error;
- paths resolve explicitly and are logged without file contents;
- changing policy/config requires appliance restart in this arc;
- sandbox provider selection remains unrelated.

Do not infer authorization from whichever API keys happen to be in the process
environment. Credentials answer “can Pi authenticate?”; the allowlist answers
“may workspace agents use this provider and incur its cost/data transfer?”

For alpha, enabling a provider authorizes every model registered under that
provider. This is intentional so OMA can expose the pinned Pi catalog without a
second copied model list. Pi upgrades require a catalog-diff/policy review
because newly registered models under an enabled provider become selectable.
Per-model cost policy is a separate follow-up, not an implicit filter.

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
`oma-models.yaml`, translate it into a second schema, or implement a competing
semantic parser. Pi remains the schema/semantic authority: construct the real
registry and require `ModelRegistry.getError() === undefined` before serving.
OMA adds only a narrow JSONC-aware raw-config security scan before construction.

The security scan must enumerate and classify every Pi 0.80.6 location that can
redirect traffic, add outbound headers, or resolve credential-like values:

- provider-level `baseUrl`, `apiKey`, and `headers`;
- model-level `baseUrl` and `headers`;
- model-override `baseUrl` and `headers`;
- API-key values in `auth.json`.

If a future pinned Pi release adds a security-sensitive field, the Pi contract
fixture/catalog-diff test must fail until the field is explicitly classified.
For alpha, validate operator files before constructing the production catalog
and reject:

- malformed Pi model config;
- providers not in the OMA allowlist;
- non-HTTPS remote base URLs; `http:` is allowed only when WHATWG `URL` parsing
  yields an exact syntactic loopback host (`localhost`, `127.0.0.0/8`, or
  `[::1]`) for an explicitly local custom provider;
- every URL containing username/password userinfo, unsupported schemes,
  malformed ports, or non-loopback HTTP hosts;
- command-backed `!command` values in any classified `models.json` credential
  or header location, or any `auth.json` API-key value, unless the operator
  explicitly enables `OMA_ALLOW_MODEL_AUTH_COMMANDS=true`;
- unsupported extension-only/custom stream implementations.

Reject symlinked auth/config files and unsafe parent/file permissions before
reading them. OMA-owned directories/files use `0700`/`0600`. Operator-supplied
paths may be read-only, but must not be group/world writable. Log resolved paths
only at startup and never their contents.

Environment interpolation (`$OPENAI_API_KEY`) remains supported through Pi.
Literal credentials in `models.json` should produce a startup warning and
documentation guidance, not be returned by any API or log. Command opt-in is
one deployment-wide policy covering both `models.json` and `auth.json`; there
is no auth-file bypass.

Pi provider extensions execute host code and are not loaded by this arc. The
compatible API adapters in `models.json` cover the intended alpha surface.

Pi 0.80.6 deliberately does not treat arbitrary provider/model headers as
credential readiness. Header values are supplemental request configuration;
`hasConfiguredAuth(model)` requires `auth.json`, a supported environment/cloud
source, or provider-level `apiKey`. A custom endpoint that authenticates with a
Bearer header should configure `apiKey` plus `authHeader:true`; header-only
authentication remains unsupported for alpha and must not bypass the session
gate. Supplemental Authorization-like headers may still be used when Pi also
reports model-scoped configured auth (for example a gateway plus upstream BYOK).

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
- create one mandatory OMA `AuthStorageBackend` and pass it through
  `AuthStorage.fromStorage()`; Pi 0.80.6's default file backend overwrites the
  file directly and does not satisfy this arc's crash-atomicity requirement;
- backend writes use a same-directory temporary file, `fsync` the file, set
  mode `0600`, atomically rename, and `fsync` the parent directory; this covers
  both API-key mutations and asynchronous OAuth refresh writes;
- synchronous and asynchronous backend operations share one inter-process lock
  across CLI and server processes; the callback always receives the latest
  durable bytes and concurrent API-key/OAuth writes cannot lose peer entries;
- preserve Pi's schema and resolution by calling `AuthStorage.set/remove`; the
  backend owns durable bytes, locking, and atomic replacement rather than a
  second auth parser;
- directory mode is `0700`, file mode is `0600`;
- refuse unsafe existing permissions until corrected;
- preserve unrelated provider credentials when updating one provider;
- never print the credential after storage;
- removal requires an exact provider name and is idempotent;
- OAuth subscription login is deferred; `status` may report existing Pi OAuth
  credentials if an operator deliberately supplied an auth file;
- `auth status` never invents one provider-level readiness boolean: it may show
  redacted provider-source metadata plus ready/total model counts computed with
  `hasConfiguredAuth(model)`;
- command-backed credentials are never created by this CLI and imported
  command-backed API-key values are rejected unless deployment opt-in is set;
- every mutating auth command prints that `oma up` must be restarted before the
  running appliance observes the change.

`oma up` passes the resolved OMA paths/policy to the control plane. The CLI and
server must call the same catalog factory so validation cannot drift.

Alpha contract: credential mutation is **restart-required**, not live reload.
The server owns one in-memory `AuthStorage` for its lifetime; a separate CLI
process cannot mutate that instance safely. Until restart, existing warm
handles and new admissions use the server's previously loaded credential
state. After restart, all session admission and durable-handle recreation use
the newly loaded state. Live reload/revocation, including concurrent OAuth
refresh coordination, is a separate post-alpha design.

### D7 — Workspace-safe discovery API

Add OMA extension route:

```text
GET /v1/model-catalog
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

Do not use `/v1/models`: Anthropic already owns that path for its public Models
API, whose wire shape and pagination differ from this OMA readiness catalog.
Keeping `/v1/model-catalog` distinct preserves room for future wire-compatible
implementation of Anthropic's endpoint instead of creating header-dependent
semantics on one path.

Route registration must add `/v1/model-catalog` to
`isManagedAgentsRoute()` (`app.ts:932-947`) before mounting the router. This is
a security invariant, not routing housekeeping: omission would skip workspace
authentication and fall back to `wrk_default`. API tests must pin missing-key
`401`, authenticated-but-missing-beta `404`, successful authenticated/beta
access, workspace isolation, and `routeClassForPath(...) === "v1"`.

`credentials_configured` is computed per returned resolved model with
`modelRegistry.hasConfiguredAuth(model)`. `default` is true only for the exact
configured `{OMA_DEFAULT_MODEL_PROVIDER,OMA_DEFAULT_MODEL}` pair. Provider
status metadata is never used as either boolean. `available=true` filters using
that same model-scoped predicate; header-only custom authentication therefore
does not appear available in alpha.

### D8 — Admission behavior

Change `AgentModelAvailability.assertAvailable(modelId)`
(`agents/service.ts:53-72`) to accept the normalized model reference.

Agent create/update:

1. normalize CMA string/provider-less input to Anthropic; retain an explicit
   OMA `provider` unchanged;
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
3. call `modelRegistry.hasConfiguredAuth(resolvedModel)` and reject before
   session rows, snapshots, mounts, or runtime state when it returns false;
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
`GET /v1/model-catalog` data:

- provider selector first;
- searchable model selector second;
- default to the exact deployment default provider/model pair only when the
  server returns it with `default:true`;
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
- dev-only official `@anthropic-ai/sdk` compatibility fixture/dependency (add
  it in this slice because the repository does not currently depend on it)

Deliver:

- provider-aware input/output types;
- CMA input normalization to Anthropic plus explicit provider handling;
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
- new `src/control-plane/models/auth-storage-backend.ts`
- `src/control-plane/app.ts`
- `src/control-plane/sessions/service.ts`
- promote Pi's pinned `proper-lockfile@4.1.2` transitive dependency to an
  explicit OMA runtime dependency for the shared inter-process lock
- store-backed agent revision provider and runner tests
- deployment configuration tests

Deliver:

- OMA-owned Pi config paths;
- provider allowlist/default-pair parsing;
- one shared registry/auth owner;
- mandatory atomic/inter-process-locking auth backend before constructing that
  owner;
- exact-pair admission and runtime resolution;
- model-scoped configured-auth session gate using
  `ModelRegistry.hasConfiguredAuth(model)`;
- restart/warm-handle no-fallback proof;
- Pi-owned semantic validation plus OMA's exhaustive narrow security scan over
  `models.json` and `auth.json`.

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
- CLI reuse of the Slice-2 atomic `AuthStorageBackend` for API-key mutations;
- explicit restart-required credential-mutation UX;
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
- CMA string/provider-less input is always materialized as Anthropic;
- explicit non-Anthropic input persists its provider unchanged;
- legacy model JSON migrates to Anthropic, idempotently;
- migration rollback on one malformed row leaves every row untouched;
- allowlist/default-pair parsing rejects empty, duplicate, unknown, and
  inconsistent configurations;
- surrounding whitespace is trimmed once, while provider IDs remain
  case-sensitive; `OpenAI` is rejected rather than aliased to `openai`;
- catalog resolves only allowed exact pairs;
- catalog never searches across providers by model ID;
- model-scoped readiness uses `hasConfiguredAuth`; provider status cannot
  change its result and reveals no secret/source details;
- custom model validator covers all enumerated base URL/header/API-key
  locations, HTTPS, exact loopback HTTP, URL userinfo, command expressions in
  both config files, literal-key warnings, unsafe files, malformed Pi model
  config, and malformed Pi auth storage;
- CLI auth writes atomically with `0600`, preserves peers, and prints no key;
- sync/async backend contention across two instances preserves both updates,
  and an injected crash before rename leaves the previous JSON intact.

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
- `/v1/model-catalog` filters, pagination, auth, beta, order, cursor binding,
  workspace isolation, route classification, and redaction;
- `/v1/model-catalog.default` identifies exactly one configured default pair and
  `credentials_configured` agrees with model-scoped Pi readiness;
- OpenAPI route/spec completeness remains green;
- official SDK create/get/list path tolerates the model provider extension.

### Pi contract

Use real Pi 0.80.6 `AuthStorage`/`ModelRegistry` with temporary files to prove:

- built-in provider discovery;
- environment credential readiness even when provider status reports
  `configured:false`;
- OMA-owned `auth.json` API-key readiness and precedence;
- `models.json` API-key readiness;
- header-only custom authentication remains unavailable until the operator
  supplies provider `apiKey`, `auth.json`, or another Pi-recognized source;
- Bedrock ambient credentials (`AWS_PROFILE`/IAM-supported sources);
- Vertex ADC readiness;
- custom OpenAI-compatible and Anthropic-compatible entries;
- custom base URL and compat fields reach the resolved Pi model;
- malformed config fails startup rather than silently dropping custom models;
- malformed auth storage fails startup rather than silently appearing empty;
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
- mutating auth prints restart-required guidance;
- after auth removal and appliance restart, session admission/handle recreation
  fails clearly and does not fall back;
- before restart, the running appliance retains its documented in-memory auth
  state rather than claiming live revocation.

### Security and observability

- API/log/OpenAPI/console snapshots contain no credentials, auth-file paths,
  custom headers, or full base URLs;
- workspace user cannot mutate catalog/auth/provider policy;
- arbitrary command expressions in every classified `models.json` location and
  `auth.json` API-key values are rejected unless explicit operator opt-in is
  present; negative tests use a sentinel command and prove it never executes;
- log catalog startup with Pi version, allowed provider names, registered model
  counts, and model-scoped ready/missing counts only;
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
   model-scoped configured auth with `ModelRegistry.hasConfiguredAuth` before
   side effects.
9. Missing/removed provider/model/auth fails closed and never selects another
   provider/model.
10. Workspace callers can discover allowed models and credential readiness but
    no secrets/config internals.
11. CLI users can inspect providers/models and safely persist/remove API-key
    credentials under OMA-owned paths, with crash-atomic writes and explicit
    restart-required semantics.
12. Console users select live providers/models rather than a hardcoded list.
13. At least one non-Anthropic and one operator-defined compatible endpoint pass
    end-to-end verification.
14. README/OpenAPI/ALPHA/PARITY describe the support tiers and limitations
    accurately.
15. Targeted tests, full Vitest, typecheck, `git diff --check`, alpha smoke, and
    real Docker provider smoke pass.
16. CMA string/provider-less model inputs always retain Anthropic meaning,
    independent of the deployment's OMA default provider/model pair.
17. Command execution policy covers both `models.json` and `auth.json`; no
    command-backed credential runs without explicit deployment opt-in.

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
command expressions disabled across both config files by default, exhaustive
classified-location scanning, and startup validation before catalog creation.

### Risk: provider credentials are shared across workspaces

Mitigation: document appliance-level credentials and operator billing boundary.
Per-workspace BYOK is a separate vault/authorization arc.

### Risk: catalog upgrades remove or change models

Mitigation: pin Pi version, persist exact provider/id, fail closed when removed,
and include catalog-diff review in Pi upgrade procedure. Do not freeze secrets or
transport definitions into revisions.

### Risk: enabling a provider unexpectedly exposes costly new catalog entries

Mitigation: document that provider policy grants every registered model under
that provider, pin Pi, and require a catalog diff/operator policy review on
each Pi upgrade. Add per-model policy only as an explicit later capability.

### Risk: high-cardinality discovery or metrics

Mitigation: paginate `(provider,id)`, cap limits at 100, use bounded provider and
reason labels in metrics, omit model IDs from Prometheus labels.

### Risk: provider status is mistaken for model credential readiness

Mitigation: compute readiness only with
`ModelRegistry.hasConfiguredAuth(resolvedModel)`; use provider status as
diagnostic metadata only. Call the field `credentials_configured`, never
`healthy` or `validated`; remote failures stay runtime errors.

### Risk: CLI credential changes appear live but the server retains stale auth

Mitigation: alpha commands explicitly require appliance restart and tests pin
the before/after-restart behavior. Do not claim live revocation until one
coordinated reload design covers admissions, warm handles, and OAuth refresh.

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

## 10. Independent review disposition

Two native reviewers evaluated revision `a970a5a` against the installed Pi
0.80.6 source and runtime behavior. This revision folds their requested changes:

- provider-level auth status was replaced by model-scoped
  `ModelRegistry.hasConfiguredAuth(model)` for discovery and admission;
- auth CLI changes are explicitly restart-required for alpha;
- command-expression policy now covers both `models.json` and `auth.json`;
- the OMA atomic, inter-process-locking `AuthStorageBackend` is mandatory;
- the deployment default is one validated provider/model pair;
- CMA string/provider-less model inputs retain Anthropic meaning;
- Pi remains semantic config owner while OMA's security scan has an exhaustive
  field, URL, permission, and upgrade contract;
- provider enablement is documented as granting every registered model under
  that provider, with catalog review required on Pi upgrades.
- OMA discovery uses authenticated `/v1/model-catalog`, leaving Anthropic's
  incompatible public `/v1/models` contract unclaimed;
- route-classification tests prevent the discovery route from bypassing
  workspace auth/beta gates;
- migration order is explicit, and Pi's header-only-auth readiness limitation,
  exact provider casing, and unchanged `speed` semantics are documented.
