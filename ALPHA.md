# Alpha Readiness Roadmap

OMA is pre-v1 alpha software. The alpha goal is not full Claude Managed Agents
parity; it is a reliable first tinkering experience for users who want to run
Managed Agents on their own machine.

Alpha success means a new user can:

1. run `npx --yes open-managed-agents@latest`;
2. complete the guided provider credential flow;
3. start or reopen the local appliance;
4. enter an authenticated console without copying a workspace key;
5. reach an idempotently created starter agent, environment, and session;
6. send a prompt;
7. watch tool/session events;
8. inspect tool inputs, results, files, and failures;
9. understand which CMA features are unsupported or intentionally deferred.

## Current status

The synchronous single-agent core is now the strongest part of the project:

```text
agent -> versioned config -> session -> sandbox -> tools -> skills -> MCP/vaults -> SSE
```

This path includes Docker and microsandbox execution, file/search tools
(`bash`, `read`, `write`, `edit`, CMA `glob`, provider-owned CMA `grep`),
permission confirmations, skills, MCP, vault credentials, session pagination,
and agent update/versioning.

The public npm package is `open-managed-agents`; `0.1.2` was the first release
whose published README leads with the one-command onboarding path. The
remaining alpha release gate is evidence: the packed-browser lane and at least
three non-maintainer warm-path observations must prove the documented
three-minute target without undocumented intervention. Source checkout remains
the advanced diagnostic and contributor path.

## Alpha worklist

### 1. Public onboarding and source-checkout diagnostics

Goal: prove the public npm path reaches a credential-backed console session in
three minutes or less under the documented warm prerequisites, while retaining
a deterministic source-checkout diagnostic path.

Deliverables:

- Keep the README's primary path to one command:
  `npx --yes open-managed-agents@latest`.
- Preflight Node, Docker-compatible daemon, port, and cached-image readiness
  before prompting for or storing credentials.
- Guide provider selection and masked credential entry, start or reuse an
  attached loopback appliance, idempotently create the OMA-owned starter graph,
  exchange a fresh single-use bootstrap nonce, and open the selected session.
- Keep missing-image pulls explicit: interactive approval or `--pull`; never
  pull implicitly for non-interactive callers.
- Persist only the private owner-readable lifecycle/resume record. Raw provider,
  workspace, and admin credentials must not enter URLs, browser storage, logs,
  process arguments, or the resume record.
- Add a packed/public-package browser gate that exercises the same onboarding
  entrypoint users run.
- Run the public warm-path human gate in
  [Alpha Onboarding Observation Protocol](docs/references/alpha-onboarding-observation.md):
  at least three non-maintainers, each successful run at or below three minutes,
  and zero undocumented intervention. Measure cold image acquisition separately.
- Maintain [Getting Started](docs/getting-started.md) as the advanced
  source-checkout diagnostic and contributor guide.
- Keep one deterministic source-checkout proof:
  `clone -> npm ci -> npm link -> oma doctor -> oma smoke --local-compatible`.
- Add the repo-local `oma` CLI (`npm link` after install):
  - `oma up` starts the durable foreground appliance with Docker-local by default;
  - `oma up --sandbox microsandbox` selects the opt-in provider;
  - `oma smoke` runs the disposable verification path;
  - `oma doctor` runs read-only, secret-safe local readiness diagnostics;
  - `oma keys mint|list` and `oma workspaces list` cover local operator recovery;
  - `oma admin init|status` provides explicit, owner-only local admin setup;
  - the server prints the console URL and redirects `/` to `/console/`;
  - detached lifecycle (`oma up --detach`, `oma logs`, `oma down`) is documented
    but explicitly not implemented yet.
- Complete CLI discovery:
  - nested `--help` for every command and subcommand;
  - examples and exit-code semantics for ordinary failure modes;
  - `oma doctor --json` for automation.
- `oma doctor` invariant: it must not create `~/.oma`, Pi auth/model files,
  lock files, databases, or pull Docker images. If a production constructor
  mutates missing paths, doctor must use a separate read-only inspection seam.
- Add a local smoke command, `oma smoke` (also available as
  `npm run alpha:smoke`), that:
  - verifies local sandbox/runtime prerequisites when it starts its own server;
  - starts an isolated temporary control plane by default, or targets an
    existing server via `OMA_ALPHA_BASE_URL` + `OMA_ALPHA_API_KEY`;
  - explicitly enables Docker-local for the temporary server by default
    (`OMA_SANDBOX_PROVIDER=docker-local`,
    `OMA_ALLOW_DOCKER_LOCAL=true`);
  - creates an agent;
  - creates a default-deny environment;
  - creates a session;
  - sends a prompt that must invoke the `bash` sandbox tool;
  - observes the public `agent.tool_use`, `agent.tool_result`, and
    `agent.message` events;
  - observes a successful assistant response;
  - cleans up created resources where safe.
- Document required environment variables and model/provider assumptions in one
  place.
- Document common first-run failures:
  - Docker not running;
  - missing or invalid model credentials;
  - default-deny networking;
  - port already in use;
  - custom image missing expected tools.
- Add automated source-checkout gates for:
  - CLI help;
  - doctor read-only behavior;
  - docs command contract;
  - browser console happy path;
  - Docker-backed local-compatible smoke.
- Track trusted npm publication/provenance and any future curl or Homebrew
  acquisition work in GitHub issue #196. npm/npx are shipped; curl and Homebrew
  are not alpha blockers.

Primary public command:

```bash
npx --yes open-managed-agents@latest
```

Advanced source-checkout diagnostics:

```bash
npm ci
npm link
oma doctor
oma smoke --local-compatible
oma up
```

Useful overrides:

```bash
OMA_ALPHA_MODEL=claude-sonnet-5 oma smoke
OMA_ALPHA_BASE_URL=http://127.0.0.1:4180 OMA_ALPHA_API_KEY=oma_... oma smoke
oma smoke --sandbox microsandbox
OMA_ALPHA_KEEP_HOME=1 oma smoke
```

`OMA_ALPHA_SANDBOX_PROVIDER` applies only when the smoke starts a temporary
server. Existing-server mode assumes the operator has already configured a
sandbox provider and skips local Docker/microsandbox prerequisite checks.

### 2. Schema-backed API documentation

Implementation plan: [0135](docs/plans/0135-alpha-openapi-docs.md).

Status: shipped in PR #189 (`e2bc6a3`); independent reviews and live browser
rendering verification complete.

Goal: provide FastAPI-like discovery without publishing a hand-maintained spec
that can drift from runtime behavior.

Deliverables:

- expose machine-readable OpenAPI at `/openapi.json`;
- serve a vendored, air-gap-safe interactive UI at `/docs/`;
- document `x-api-key` and the required `anthropic-beta` header;
- separate CMA-compatible `/v1` operations from OMA operator/admin operations;
- include request/response/error schemas, examples, pagination, and SSE event
  documentation;
- generate the document from shared route schemas, or enforce equivalent
  route/spec coverage in tests;
- omit unsupported CMA operations rather than advertising future behavior.

Implementation notes:

- a route-contract registry generates deterministic OpenAPI 3.1 JSON;
- CI compares every shipped `/v1`, `/admin`, `/health`, and `/metrics` route
  against that registry;
- `swagger-ui-dist@5.32.8` is vendored as static assets with recorded license,
  integrity, and file hashes—there is no runtime package or CDN dependency;
- Swagger UI's remote validator and authorization persistence are disabled.

### 3. Console task-parity audit

Implementation plan: [0136](docs/plans/0136-alpha-console-task-parity.md).

Status: audit and implementation complete and independently reviewed on
`dev/alpha-console-live-workflow`. Static rendering, API integration, the full
test suite, the Docker-local alpha smoke, and a real Chrome walkthrough are
green. The browser gate covered login, agent/environment/session creation,
authenticated SSE, an `always_ask` bash confirmation, tool output, the final
agent message, and the idle transition.

OMA already has a bundled console. The alpha question is therefore narrower
than "build a UI": identify the minimum guided workflow the existing console
must support.

Use local CMA screenshots as private reference captures only. They are ignored
by git under `ui/CMA_screenshots/`.

Audit task parity against these jobs:

- workspace authentication / readiness;
- agent create, list, and detail;
- environment readiness;
- credential/vault readiness;
- session create / test run;
- prompt send and interrupt;
- transcript/debug event viewer;
- tool input/result/error inspection;
- file/output inspection;
- loading, empty, and failure states.

Output:

- must-have for alpha;
- should-have after alpha;
- defer / not pursuing pixel parity.

Audit conclusion: the existing console was already a strong read-only inspector.
The implementation now adds API-backed agent/environment/session creation,
prompt and interrupt actions, authenticated live SSE, and real
tool-confirmation handling. Agent creation and immutable updates expose
`always_ask` versus `always_allow`; agent archive and idle-session
archive/delete are real server mutations rather than browser-only state.
Environment archive/delete is now available: archive preserves existing
sessions but prevents new ones, and OMA refuses deletion while any durable
session references the environment (tracked in [PARITY.md](PARITY.md)).
CMA's conversational Quickstart, deployments, analytics, and pixel parity are
deferred.

### 4. Minimum safe console mutations

The console currently supports browsing/admin surfaces better than end-to-end
mutation flows. For alpha, enable only the safe minimum needed for the happy
path:

- create agent;
- create environment;
- create session;
- send prompt;
- interrupt a running session;
- optionally archive/delete only where service guards already make the action
  safe.

Do not attempt full hosted-console parity in this slice.

### 5. Session transcript and debug timeline

The console must make a session understandable without tailing logs or querying
SQLite.

Minimum timeline requirements:

- session running / idle / failed state transitions;
- user messages;
- assistant messages;
- tool use;
- tool result;
- tool error;
- rendered and raw detail panes for tool inputs/results;
- clear interrupt state.

This should use the real SSE event stream rather than a separate polling-only
debug path.

### 6. Event honesty

Make unsupported event behavior explicit before alpha users build against it.

Required:

- [x] reject unsupported `event_deltas[]` values before stream admission;
- [x] stop presenting `agent.thinking` as supported;
- [x] mark `system.message` unsupported/deferred;
- [x] document that assistant text is buffered and streaming preview parity is
  deferred.

Full token-by-token preview streaming can be deferred if buffered
`agent.message` remains correct and the console timeline is usable.

### 7. Default environment image story

The original `bash:5.2` / `alpine:latest` defaults were intentionally thin. A
minimal OMA-owned replacement is shipped by plan 0138 as the digest-pinned
Docker-local and microsandbox-local alpha default.

Near-term target:

- [x] define a minimal OMA-owned, multi-architecture default image;
- [x] include pinned Bash and ripgrep for the documented smoke and grep paths;
- [x] verify anonymous pull of the digest-pinned GHCR image and use it as the
  Docker-local and microsandbox-local default (#187 / plan 0138 / PR #193);
- [x] replace the execution-minimal image with a useful alpha
  coding image containing pinned Node/npm, Python/uv, Git, curl, jq, archive
  tools, and a deliberate native-build-tool policy while preserving the
  digest-pinned, multi-architecture, non-root/read-only security contract
  ([#200](https://github.com/oneryalcin/open-managed-agents/issues/200), plan
  0140, PR #202). Registry-backed install proof remains coupled to the
  separately tracked network presets in #199;
- [x] make safe network-enabled environments usable from the console: keep
  offline as the default, add reviewed npm/PyPI and GitHub presets plus a
  custom hostname allowlist, and replace the internal sidecar-knob sequence
  with a supported `oma up` egress path
  ([#199](https://github.com/oneryalcin/open-managed-agents/issues/199), plan
  0141). The deterministic acceptance proof is `oma smoke --egress`.

The coding image and networking UX are separate delivery slices. The image
must never widen egress by itself, and networking presets must remain useful
only when the deployment has explicitly enabled the Docker-local egress
boundary.

### 8. Pi-backed multi-provider models

Implementation plan: [0139](docs/plans/0139-pi-multi-provider-models.md).

Status: complete and independently reviewed on `dev/pi-multi-provider-models-plan`.
Durable `{provider,id}` identity, the shared Pi catalog/runtime boundary,
authenticated discovery API, secret-safe operator CLI, live console selection,
a no-paid-API custom compatible-provider smoke, and credential-gated live
provider lanes are implemented. A fresh checkout passed install, typecheck, the
full suite, and the Docker-backed local-compatible provider smoke.

Goal: make model choice an OMA product capability rather than an Anthropic-only
deployment assumption, while reusing Pi's provider catalog, protocol adapters,
auth storage, credential resolution, and custom `models.json` format.

Required before the final alpha audit:

- preserve existing CMA-compatible Anthropic model input;
- add explicit `{provider,id}` model selection for OMA agents;
- persist the provider on every immutable agent revision and migrate historical
  rows to explicit Anthropic identity;
- use one shared Pi `AuthStorage`/`ModelRegistry` for admission and runtime;
- load Pi configuration from OMA-owned paths rather than ambient
  `~/.pi/agent` state;
- support operator-allowed Pi built-ins plus operator-defined compatible APIs;
- add secret-safe provider/model discovery through CLI, API, and console;
- fail closed when provider policy, model registration, or configured auth is
  missing—never fall back to another model;
- verify at least one non-Anthropic and one local custom compatible provider.

The deterministic proof is `oma smoke --local-compatible`; the opt-in live
matrix is `npm run alpha:smoke:providers`. Paid provider lanes run only when
selected/configured, and the ordinary smoke still exercises CMA's Anthropic
string-model input.

The alpha claim is “Pi-supported when operator-enabled and configured,” not
“every Pi model is independently certified by OMA.” Documentation must separate
OMA-verified, Pi-supported, and operator-defined support tiers.

### 9. Alpha release checklist

Before inviting external tinkering:

- README quickstart passes from clean checkout.
- Local smoke command passes.
- Docker provider path works.
- Microsandbox support level is documented honestly.
- Console happy path works for create-agent -> create-session -> prompt -> event
  inspection.
- Unsupported CMA features fail closed or are clearly documented.
- [PARITY.md](PARITY.md) is current.
- Known limitations are short, visible, and accurate.

## Explicit non-goals for alpha

- Pixel-perfect CMA console clone.
- Full multi-agent runtime.
- Memory stores / dreams.
- Scheduled deployments.
- GitHub repo mounts.
- Webhooks.
- Outcomes/evaluation.
- Full hosted environment provisioning parity.
- Arbitrary user-selected sandbox images and broad language/runtime profiles.
