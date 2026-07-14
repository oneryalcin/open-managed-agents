# Alpha Readiness Roadmap

OMA is pre-v1 alpha software. The alpha goal is not full Claude Managed Agents
parity; it is a reliable first tinkering experience for users who want to run
Managed Agents on their own machine.

Alpha success means a new user can:

1. clone the repository;
2. install and start OMA;
3. authenticate a workspace;
4. create an agent;
5. create an environment;
6. create a session;
7. send a prompt;
8. watch tool/session events;
9. inspect tool inputs, results, files, and failures;
10. understand which CMA features are unsupported or intentionally deferred.

## Current status

The synchronous single-agent core is now the strongest part of the project:

```text
agent -> versioned config -> session -> sandbox -> tools -> skills -> MCP/vaults -> SSE
```

This path includes Docker and microsandbox execution, file/search tools
(`bash`, `read`, `write`, `edit`, CMA `glob`, provider-owned CMA `grep`),
permission confirmations, skills, MCP, vault credentials, session pagination,
and agent update/versioning.

The remaining alpha work is about first-run reliability, console task flow, and
honest unsupported-feature boundaries.

## Alpha worklist

### 1. Clean-checkout onboarding and smoke test

Goal: prove the documented setup works from a fresh checkout.

Deliverables:

- Verify the README quickstart from a clean checkout.
- Add one canonical "hello managed agent" flow.
- Add the repo-local `oma` CLI (`npm link` after install):
  - `oma up` starts the durable foreground appliance with Docker-local by default;
  - `oma up --sandbox microsandbox` selects the opt-in provider;
  - `oma smoke` runs the disposable verification path;
  - `oma keys mint|list` and `oma workspaces list` cover local operator recovery;
  - `oma admin init|status` provides explicit, owner-only local admin setup;
  - the server prints the console URL and redirects `/` to `/console/`;
  - detached lifecycle (`oma up --detach`, `oma logs`, `oma down`) is documented
    but explicitly not implemented yet.
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

Current commands:

```bash
npm install
npm link
oma up
oma smoke
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

Status: audit complete and independently reviewed on
`dev/alpha-console-task-audit`; plan 0136 is implementation-ready.

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

Audit conclusion: the existing console is already a strong read-only inspector.
Alpha requires API-backed agent/environment/session creation, prompt and
interrupt actions, authenticated live SSE, and real tool-confirmation handling.
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

- reject or clearly validate unsupported `event_deltas[]` values;
- either emit `agent.thinking` correctly or stop presenting it as supported;
- either emit `system.message` correctly or mark it unsupported/deferred;
- document that streaming text-preview parity is not complete unless/until it is
  implemented.

Full token-by-token preview streaming can be deferred if buffered
`agent.message` remains correct and the console timeline is usable.

### 7. Default environment image story

The current default images are intentionally thin. For alpha users, the sandbox
should be useful without immediately requiring a custom image.

Near-term target:

- define a minimal OMA-owned default image;
- include the tools needed by the documented smoke path;
- strongly consider pinned `ripgrep` in this image for future grep parity
  (#187);
- keep Python/Node/package-rich images as a later environment arc unless the
  smoke path requires them.

### 8. Alpha release checklist

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
- Full ripgrep regex parity before the OMA-owned image work.
