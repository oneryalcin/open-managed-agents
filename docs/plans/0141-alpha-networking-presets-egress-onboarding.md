# 0141 — Alpha networking presets and egress onboarding

## Status

Approved by deliberate architecture and critic review. Implements GitHub issue
[#199](https://github.com/oneryalcin/open-managed-agents/issues/199) and closes
the registry-backed acceptance gap left by #200.

## Requirements summary

The alpha coding image now contains npm, uv, Python, and Git, but the console
can create only an offline environment and `oma up` does not configure the
existing Docker egress boundary. This slice must make safe, bounded egress a
normal alpha workflow without granting unrestricted networking.

The shipped path must:

- keep `limited + []` as the default and as a true no-proxy environment;
- provide reviewed npm/PyPI and GitHub-plus-registry presets;
- provide a custom exact/leading-wildcard hostname allowlist;
- make one server-owned preset catalog the source of truth for the console;
- make Docker-local launched by `oma up` capable of honoring non-empty
  allowlists without undocumented environment variables;
- keep microsandbox and every unsupported deployment fail-closed;
- keep environment records immutable;
- prove real npm, uv, and GitHub traffic through the proxy while unrelated
  destinations stay denied.

## Non-goals

- No unrestricted networking.
- No support for CMA `allow_package_managers:true` or
  `allow_mcp_servers:true`; both remain rejected.
- No microsandbox egress implementation.
- No environment update endpoint.
- No secret injection UX changes.
- No attempt to guarantee every future npm/PyPI/GitHub CDN host. Preset host
  changes are versioned policy changes backed by tests.

## Current evidence and seams

- `parseNetworkingConfig` already strictly separates hosted and native shapes,
  normalizes hosted hosts, rejects duplicates/unrestricted/unsupported flags,
  and maps non-empty hosted lists to HTTPS/443 only
  (`src/control-plane/egress/policy.ts:103-193`).
- Docker-local already implements a proxy-only internal network with a
  hardened per-session sidecar; absent egress wiring keeps `--network none`
  (`src/control-plane/sessions/pi/sandbox/docker.ts:912-973`).
- Deployment config currently requires the internal pair
  `OMA_ENABLE_EGRESS=true` and `OMA_EGRESS_SIDECAR_IMAGE`
  (`src/control-plane/deployment-runtime-config.ts:282-315`).
- `oma up` selects Docker-local but supplies no egress configuration
  (`bin/oma.mjs:73-111`).
- `oma doctor` inspects the coding image read-only but does not report the
  egress sidecar (`scripts/oma-doctor.ts:101-132`).
- The console hard-codes one empty allowlist and posts it directly
  (`ui/managed-agents-console/src/environments.jsx:3-68`).
- Environment creation already validates networking before persistence
  (`src/control-plane/environments/service.ts:53-85`).
- Session admission already rejects non-empty networking when the deployment
  cannot honor it, before runtime preparation
  (`src/control-plane/sessions/service.ts:328-351`).

## RALPLAN-DR summary

### Principles

1. Deployment capability never grants traffic; only an immutable environment
   allowlist does.
2. Presets are security policy and have exactly one server-owned definition.
3. Offline remains the default and creates no sidecar.
4. The user sees exact hosts and exact deployment readiness before submission.
5. Every positive network proof is paired with a negative unrelated-host
   proof and cleanup evidence.

### Decision drivers

1. A fresh `oma up` Docker workflow must work without internal egress knobs.
2. Preset/runtime behavior must not drift across API, console, tests, and docs.
3. The solution must preserve the existing proxy-only boundary and remain
   independently reviewable.

### Options

#### Option A — Published dedicated sidecar image (favored)

Publish a minimal OMA egress-sidecar OCI image, pin its multi-arch digest in
the repository, and have Docker `oma up` inject that exact reference.

Pros: immutable/reproducible runtime, no host-repo bind mount, clean production
shape, compatible with source checkout and future package distribution.

Cons: adds a publication workflow/package, supply-chain maintenance, and a
bootstrap promotion step before the final digest can be committed.

#### Option B — Pinned Node image plus read-only source-checkout bind mount

Have `oma up` set the already-supported `sidecarRepoMount` to the checkout root
and run the proxy from a digest-pinned Node image.

Pros: fastest, reuses a test-proven path, no new registry package.

Cons: couples runtime correctness to checkout layout and host `node_modules`,
does not work for a packaged CLI/appliance, and turns host source into a
production runtime dependency.

#### Option C — Build a local sidecar image during `oma up`

Pros: no published binary artifact.

Cons: mutates local Docker state during startup, adds an expensive hidden
build/download, makes doctor/readiness harder, and is less reproducible.

### Decision

Choose Option A. Option B remains a test/dev seam only; Option C is rejected
because ordinary startup must not hide a build pipeline.

## Architecture decisions

### D1 — Versioned server-owned preset catalog

Add `src/control-plane/egress/presets.ts` containing immutable preset records:

- `offline-v1`: `[]`;
- `npm-pypi-v1`: reviewed npm and PyPI hosts;
- `github-packages-v1`: the registry set plus reviewed GitHub HTTPS
  clone/archive/download hosts.

Each record contains stable `id`, `version`, user-facing name/description, and
an ordered, normalized `allowed_hosts` array. Construction passes each preset
through the same hosted parser used for persistence. Duplicate or malformed
catalog entries fail tests/startup rather than being corrected silently.

Add a canonical hosted-networking helper beside `parseNetworkingConfig`.
Environment creation uses it to persist lowercase, normalized, duplicate-free
host lists rather than merely validating while storing caller casing. Preserve
explicit supported `false` flags only if supplied; never synthesize the still-
unsupported `true` flags. This intentionally replaces the current
"preserve caller config" test with a canonical-persistence contract.

Initial candidate lists must be finalized from primary documentation and real
proxy-path probes. The minimum expected registry list is
`registry.npmjs.org`, `pypi.org`, and `files.pythonhosted.org`. The GitHub list
must include `github.com`, `api.github.com`, the archive host, and only the
empirically needed `githubusercontent.com` family entries. Avoid broad cloud
provider suffixes such as `*.amazonaws.com`.

### D2 — Authenticated discovery endpoint carries capability and policy

Extend the environment routes with
`GET /v1/environments/networking-presets` before `/:id`. Its response is
secret-free and workspace-auth/beta gated through the existing
`/v1/environments` prefix. It returns:

```json
{
  "type": "environment_networking_presets",
  "deployment": {
    "provider": "docker-local",
    "egress_supported": true,
    "reason": null
  },
  "presets": [
    {
      "id": "offline-v1",
      "name": "Offline",
      "description": "No network access",
      "networking": {"type":"limited","allowed_hosts":[]}
    }
  ],
  "custom": {
    "https_only": true,
    "wildcard_matches_bare_domain": false
  }
}
```

The deployment assembly derives `egress_supported` from the same parsed
runtime config passed to session admission. In-memory/minimal apps explicitly
report unsupported instead of inventing readiness. Add the operation to
OpenAPI and route-completeness tests.

### D3 — Dedicated, digest-pinned sidecar artifact

Add `images/egress-sidecar/Dockerfile` with a digest-pinned Node base, production
dependencies, only the source needed by `src/egress-proxy-main.ts`, OCI labels,
and a non-root default. The provider still supplies `--read-only`, cap drop,
no-new-privileges, tmpfs, memory, PID, bundle, and shared-directory constraints.

Add `.github/workflows/publish-egress-sidecar-image.yml` mirroring the coding
image's pinned-action, multi-arch, immutable-tag, anonymous-pull, SBOM,
provenance, size-budget, and CRITICAL-scan gates. Add a smoke that starts the
exact image entrypoint with a synthetic bundle and verifies readiness plus an
authenticated deny response without logging bundle secrets.

After publishing, pin the resulting multi-arch digest in
`src/control-plane/egress/image.ts`. Tags are never used by production
defaults.

### D4 — `oma up` makes Docker egress capability available by default

For `oma up` with Docker-local, supply `OMA_ENABLE_EGRESS=true` and the pinned
sidecar image unless the caller provided a complete advanced internal pair.
This enables capability only: offline environments still resolve no policy,
create no sidecar, and run with `--network none`.

Do not expose an unrestricted CLI flag. Microsandbox startup supplies no
egress settings. Existing low-level environment parsing remains strict:

- image without enabled flag is an error;
- enabled flag without image is an error for direct deployment startup;
- egress settings with non-Docker providers are errors;
- `oma up` never silently mixes an operator-provided partial override with a
  default. It either uses the full supported default or accepts a complete
  explicit pair.

Startup output states: `Network capability: Docker allowlists available
(offline by default)`. It must not imply that any session already has access.

### D5 — Doctor remains read-only

For Docker, `oma doctor` reports separately:

- Docker runtime readiness;
- coding image presence;
- egress capability configured by the supported `oma up` path;
- pinned sidecar image present/missing.

A missing sidecar image is a warning before first networked session, not a
pull. Doctor must not create `~/.oma`, auth/models files, locks, databases,
networks, containers, or images. Microsandbox reports that environment
allowlists are unsupported.

### D6 — Console consumes the server catalog

`loadConsoleData` fetches the preset endpoint with the other workspace data.
The Create Environment modal:

- defaults to Offline;
- displays built-in choices and Custom;
- displays the exact normalized `allowed_hosts` JSON before submission;
- parses custom input as newline/comma-separated entries, trims/lowercases,
  rejects empty/duplicate/invalid entries using a browser-side UX mirror, and
  still submits to the authoritative server parser;
- explains that `*.example.com` excludes `example.com`;
- clearly shows deployment capability separately from selected policy;
- disables non-offline submission when the deployment reports unsupported;
- preserves the server's action-time error verbatim and never falls back to
  demo data;
- states that changes require a new environment and session.

The browser parser performs only delimiter splitting and basic immediate UX
checks. Canonical validation is server-owned: add a read-only authenticated
`POST /v1/environments/networking-presets/validate` operation that accepts an
`allowed_hosts` array and returns its canonical form or the normal error
envelope. The console validates before enabling Custom submission; environment
creation validates again before persistence. This avoids duplicating hostname
grammar in browser code.

Existing environment rows display `Offline`, `N allowed hosts`, or `Native
policy`; they do not infer that the deployment can honor old records.

### D7 — Real proxy-path acceptance matrix

Add a gated Docker test/script using the pinned coding image and sidecar:

1. Offline: npm, uv/PyPI, and GitHub attempts fail; no sidecar/container/network
   is created.
2. npm/PyPI: install one tiny pinned npm package and one tiny pinned Python
   package into workspace-local locations; both succeed; an unrelated HTTPS
   host fails.
3. GitHub+registries: clone a tiny pinned public repository/commit and perform
   the registry checks; an unrelated host fails.
4. Custom: exact host works, wildcard subdomain works, bare suffix remains
   denied unless separately listed.
5. Redirect: an allowed origin redirecting to a denied target is denied by the
   proxy's second destination check.
6. Secret hygiene: proxy credentials/sentinels/real secrets do not appear in
   guest env dumps, files, public tool output, sidecar logs, or test artifacts.
7. Cleanup: after success, denial, timeout, and cancellation, no labeled
   sidecar containers, internal networks, or temp roots remain.

Tests use bounded timeouts and pinned package/repository inputs. Network-backed
tests are an explicit CI job, not silently skipped in the primary contract
suite.

## Implementation slices

1. **Catalog and API contract (independently mergeable)**
   - implement typed presets and discovery response;
   - thread actual deployment capability into environment routes;
   - OpenAPI/auth/beta/route-completeness tests.
2. **Console workflow (depends only on slice 1)**
   - fetch catalog, build four-choice modal, custom validation, capability
     messaging, immutable-policy copy, environment labels;
   - browser/API tests;
   - keep networked presets visibly unavailable until deployment capability is
     present, so this slice is honest even before image promotion.
3. **Sidecar artifact and supported startup**
   - add Dockerfile, smoke, publication workflow, immutable digest;
   - wire Docker `oma up` defaults and strict override behavior;
   - extend read-only doctor.
4. **Real network proof and documentation**
   - run and tune host lists only from observed required destinations;
   - add registry/GitHub/deny/redirect/secret/cleanup gates;
   - update Getting Started, deployment tutorial, README, ALPHA, PARITY,
     handoff, and issue #200 closure evidence.

## Acceptance criteria

- `oma up` with default Docker configuration can run a non-empty allowlist
  session without setting undocumented egress variables.
- Offline is selected by default, persists exactly
  `{networking:{type:"limited",allowed_hosts:[]}}`, creates no sidecar, and has
  no network route.
- Built-in presets are ordered, normalized, duplicate-free, versioned, and
  returned from one authenticated server source.
- Custom exact/wildcard validation matches the backend corpus; wildcard does
  not include the bare suffix.
- Console shows policy and deployment capability as separate facts, exact
  hosts before submission, and action-time errors without fallback.
- Non-empty networking on an incapable deployment fails before session rows,
  snapshots, mounts, containers, or runtime handles.
- Real npm and uv installs succeed only under the registry preset.
- Real GitHub clone/archive succeeds only under the GitHub preset.
- An unrelated destination and a denied redirect target remain blocked in
  every networked preset.
- No secret crosses into guest-visible state or logs.
- Every egress test ends without residual sidecars, networks, or temp roots.
- Doctor reports image/readiness state without any filesystem or Docker
  mutation.

## Expanded test plan

### Unit

- preset catalog schema, ordering, exact hosts, normalization, duplicates;
- browser custom parser corpus vs server parser corpus;
- `oma up` env derivation and strict partial-override rejection;
- doctor report and zero-mutation fakes;
- console labels and immutable-policy copy.

### Integration

- authenticated/beta-gated preset endpoint and OpenAPI completeness;
- deployment capability wiring for Docker-enabled, Docker-disabled,
  microsandbox, and in-memory apps;
- session-admission no-side-effect rejection;
- exact sidecar digest in Docker arguments.

### E2E

- real Docker npm, uv, GitHub, custom wildcard, denial, redirect, secret, and
  cleanup matrix from D7;
- browser create flow for all four choices and displayed JSON;
- clean-checkout `oma doctor` then `oma up` then registry-enabled session.

### Observability

- startup logs distinguish capability from granted policy;
- sidecar logs remain secret-free;
- existing bounded egress metrics retain low-cardinality labels;
- failures identify policy denial vs deployment incapability vs missing image.

## Pre-mortem

1. **Preset works today but breaks after a CDN change.** Mitigation: versioned
   catalog, pinned real install probes, explicit docs, no broad emergency
   wildcard; changes require review and a new preset version.
2. **Capability default accidentally widens offline sessions.** Mitigation:
   preserve `parseNetworkingConfig(...empty...) -> undefined`, assert no
   sidecar/no network in unit and real Docker tests, and keep capability and
   policy separate in types/UI.
3. **Published sidecar drifts from control-plane bundle format.** Mitigation:
   build from the same commit, immutable digest, synthetic bundle smoke,
   version/schema validation at sidecar startup, and exact-digest E2E.

## Risks and mitigations

- **Registry host incompleteness:** empirically capture required destinations;
  fail closed and document how to add Custom entries.
- **Overbroad GitHub wildcard:** prefer exact hosts; accept a leading wildcard
  only when multiple observed `githubusercontent.com` subdomains require it.
- **Image bootstrap:** publish a pre-release immutable tag, verify anonymous
  pull, then commit the digest; never merge a placeholder/tag default.
- **Browser/server validation drift:** shared server catalog plus corpus parity
  test; server remains authoritative.
- **Hotspot/flaky public tests:** use tiny pinned artifacts, bounded retries only
  around transport setup, and never convert policy failures into retries.

## Verification commands

```text
npm run typecheck
npm test -- src/control-plane/egress src/control-plane/__tests__/deployment-runtime-config.test.ts src/control-plane/__tests__/egress-session-wiring.test.ts
npm test -- ui/managed-agents-console/src/__tests__
npm run alpha:console-browser
npm test
node scripts/<registry-egress-smoke>.mjs
git diff --check
```

Listener/Docker tests that fail only because of a restricted sandbox are rerun
in a capable environment before drawing a conclusion.

## ADR

### Decision

Ship server-owned versioned presets and a dedicated digest-pinned egress
sidecar automatically configured by Docker `oma up`.

### Drivers

Seamless alpha onboarding, fail-closed policy integrity, and reproducible
runtime artifacts.

### Alternatives considered

Pinned Node plus source bind mount; hidden local build during startup.

### Why chosen

The dedicated artifact is the only option that is both a one-command checkout
experience and a credible packaged/deployed runtime without trusting mutable
host source.

### Consequences

OMA owns another OCI artifact and its release/security maintenance. Docker
downloads it only when needed; offline sessions remain unchanged.

### Follow-ups

- Revisit microsandbox networking only with an equivalent boundary design.
- Add environment update/versioning separately.
- Track future preset versions when upstream registries change hosts.

## Execution staffing

Available roles: `explore`, `researcher`, `architect`, `critic`, `executor`,
`test-engineer`, `verifier`, `code-reviewer`, and `designer`.

- One `executor` owns catalog/API/CLI/image wiring.
- One `designer` or frontend `executor` owns console UX after the endpoint is
  stable.
- One `test-engineer` owns the real proxy-path matrix and cleanup evidence.
- One `verifier` independently reruns exact-digest and clean-checkout gates.

For a parallel implementation, `$team` can run these three delivery lanes
while `$ultragoal` owns the durable completion ledger and checkpoints only
verified evidence. Example launch hint:

```text
$team 3:executor "Implement .omx/plans/0141-alpha-networking-presets-egress-onboarding.md; split backend/image, console, and e2e verification lanes"
```

Team shutdown requires typecheck, focused/full tests, browser smoke, exact-
digest real egress proof, cleanup evidence, and an independent review. For a
single-owner persistent fallback, use `$ralph` only if parallel ownership would
create shared-file conflicts.

## Goal-mode follow-up suggestions

Use `$ultragoal` for durable implementation tracking, combined with `$team`
when parallel lanes are useful. This is not a research or performance project,
so `$autoresearch-goal` and `$performance-goal` are not the primary paths.

## Review changelog

- Architect: retained the dedicated image, required slice staging so catalog,
  API, and console remain independently useful before publication, and kept
  doctor/startup strictly fail-closed.
- Critic: approved with execution watches for repo-root sidecar build context,
  explicit complete-pair override semantics, and empirically minimized hosts.
- Added server-side canonical persistence and a read-only validation endpoint
  so browser hostname grammar cannot drift from runtime policy.
