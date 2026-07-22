# 0143 — Three-minute public onboarding

## Status

Proposed implementation contract for [#196](https://github.com/oneryalcin/open-managed-agents/issues/196). It does not supersede the source-checkout alpha protocol or its historical timing targets. It defines the public-install, warm-runtime path that #196 must ship before public documentation advertises `npx`.

Implementation now includes `oma onboard`'s read-only prerequisite and
provider-credential path, attached loopback appliance lifecycle, process-local
single-use console bootstrap, browser fragment exchange, and marker-based
starter agent/environment/session creation. The bootstrap's temporary
workspace key is never printed and is revoked at normal shutdown; the browser
receives only the ordinary opaque HttpOnly console session. Environment
metadata was added to the public resource contract so onboarding ownership is
not hidden in a display name or an inert config field.

This is still not the verified public one-command experience: reuse of an
already-running compatible appliance plus M3's packaged browser/performance
gate and human timing study remain. Public onboarding documentation must
continue to use the source-checkout alpha flow until those gates are complete.

## Product outcome

A new operator who already has a supported Node runtime, a running Docker-compatible daemon, and the OMA sandbox image cached can reach a credential-backed first-session screen in **three minutes or less** by running one command:

```bash
npx open-managed-agents@next
```

The command is intentionally interactive. It presents a modern terminal flow with concise progress, a provider choice, and a masked API-key prompt; it does not require a repository checkout, `npm link`, an exported environment variable, a workspace API key, agent YAML, or prior knowledge of OMA resources.

The public package name in the example is a release decision, not a claim that the npm name is available. The release owner must reserve/confirm it before publishing. The installed executable remains `oma`.

## Scope and clock

### Warm-path service-level objective

The timer starts when the operator submits the explicit `npx …` command. It stops when all of the following are true:

1. OMA is serving on a loopback port;
2. the browser console is open with an authenticated session for the default workspace;
3. a deterministic starter agent and offline starter environment exist; and
4. a first session using that agent and environment is selected and ready for the operator's first message.

The end state is **session ready**, not a fabricated model response. OMA may verify that credential storage and model-catalog readiness succeeded, but it must not spend provider credits or claim a remote key is valid before the operator sends a real prompt.

The ≤180-second SLO includes npm package resolution and all OMA work. It excludes only these documented prerequisites:

- Node.js at the package's supported version is installed;
- Docker or OrbStack is running; and
- the digest-pinned OMA sandbox image is already present locally.

A missing image is a separate cold-start condition. The onboarding command must detect it before mutating OMA state and say exactly which image must be pulled; image download time must be reported separately, never hidden inside the warm-path result.

### Non-goals

- Docker installation, daemon startup, or sandbox-image download UX.
- curl and Homebrew installers. They remain #196 release channels, but must use the same packaged CLI and later receive their own acquisition tests.
- Remote/hosted OMA setup, TLS configuration, workspace switching, admin setup, MCP, vault, skill, file, or network-policy setup.
- Agent generation, template browsing, deployment, webhooks, analytics, or a provider model-response benchmark.
- Replacing the existing source-checkout alpha path before the public-install contract is implemented and verified.

## Design principles

1. **One explicit command, one primary path.** The command itself authorizes the bootstrap; it must not behave as a silent npm install hook. Package acquisition never starts OMA merely because npm installed it.
2. **Progressive disclosure.** The terminal asks only for a provider and, when needed, its credential. Model selection, workspace administration, and advanced configuration stay in the console after first success.
3. **Visible, recoverable state.** Each step has a plain-language success, in-progress, or repair state. Raw stack traces go behind a `--debug` option; ordinary failures include one next command or action.
4. **No secret regressions.** API keys are masked, never accepted as command-line arguments, never written to terminal output, URLs, logs, shell history, browser storage, or fixture snapshots. The existing owned `0700` directory / `0600` auth-file backend remains the credential writer.
5. **No fake readiness.** Docker readiness is checked without pulling; model readiness means a stored credential is associated with a selectable configured model; sandbox execution remains verified only by a real tool run, as the console already states.
6. **Idempotent reruns.** A healthy running OMA instance is reused or opened rather than replaced. The starter resources are found by their onboarding marker before creation, so a retry does not accumulate agents, environments, or sessions.

## Proposed terminal experience

The implementation may use a small, maintained prompt renderer, but its rendering must sit behind an OMA-owned terminal adapter so unit tests can assert state transitions without a real TTY. Do not copy an external CLI's visual assets or source; adopt the interaction pattern only.

```text
◆ Open Managed Agents
│
◇ Docker ready
◇ OMA runtime ready
│
◆ Choose a model provider
│  ● Anthropic
│  ○ OpenAI
│  ○ OpenRouter
│  ○ Compatible endpoint
│
◆ Paste API key
│  ••••••••••••••••••
│
◇ Saving credential securely
◇ Starting local OMA
◇ Preparing your first session
│
└  Ready — console opened at http://127.0.0.1:4180/console/
```

Provider choices are the currently enabled product providers. A compatible endpoint is shown only when the deployed package has a supported, documented configuration path; it must not invite the operator into an incomplete form.

If the selected provider already has a stored credential, the default is to reuse it and show a non-secret status. The operator can deliberately replace it. A non-interactive invocation must not hang: it requires explicit provider selection plus credential input through stdin or an existing credential, and it emits machine-readable progress when `--json` is requested.

## Architecture and resource ownership

### Command boundary

Add a dedicated `oma onboard` command. The package's zero-argument `npx` entrypoint may dispatch to that command, while installed `oma` keeps its existing explicit subcommands. `oma up` retains its current foreground-appliance contract; onboarding is a higher-level orchestrator and must not silently change `oma up` semantics.

The orchestrator performs this ordered state machine:

1. check Node, terminal capability, Docker daemon, available loopback port, and cached sandbox digest without writing OMA state;
2. select or reuse a provider credential through the existing Pi `AuthStorage` path;
3. start the appliance as a child, wait for a bounded health/readiness signal, and retain ownership for clean interruption;
4. authenticate the local browser through a one-time, narrowly scoped console-bootstrap exchange;
5. create or reuse the starter agent, offline environment, and first session through the real authenticated API; and
6. open the selected session URL, then keep the appliance attached to the terminal until normal shutdown.

An occupied default port must not strand the operator. Onboarding may choose an available loopback port and display it; ordinary `oma up` keeps its stable explicit-port behavior. If a compatible appliance is already healthy, onboarding must offer/reuse that instance rather than create competing durable state.

### Credential persistence

The TUI writes a provider key through the existing `AuthStorage` backend used by `oma auth set`, not a separate onboarding config file and not the browser. The backend's ownership, symlink, file-mode, locking, and atomic-replace checks remain mandatory. The TUI accepts the key only from a masked prompt or stdin; no `--api-key value` option is allowed.

The package must make the resulting configured-model state observable without printing credentials. A provider authentication error on the operator's first real prompt is displayed as a normal session failure with a repair link to `oma onboard` or `oma auth set`; it must not echo the rejected secret.

### Console bootstrap

Today the first workspace key is printed once and manually pasted into the console. That is incompatible with the one-input flow. Add a local-only, short-lived, single-use console-bootstrap capability that creates the same opaque HttpOnly browser session as the existing workspace-key exchange.

The bootstrap capability is not an API key and cannot call `/v1`. It is bound to the loopback appliance, expires quickly, can be consumed once, and is invalidated when the CLI exits or startup fails. If a browser handoff requires a value in the URL, it must be a bootstrap nonce in the fragment, immediately exchanged over the same-origin loopback connection, and removed with `history.replaceState`; raw workspace/admin keys must never appear in a URL, referrer, logs, or browser storage.

This boundary needs an explicit threat-model review. In particular, implementation must address another local process attempting to consume the bootstrap capability first, browser-launch failure, expired/replayed nonce, non-loopback hosts, and TLS-terminated deployments. The capability is only for the local onboarding command; it is not a general passwordless console login endpoint.

### Starter resources

The starter agent uses the selected configured model and a concise system prompt that explains it is a local starter. The starter environment is offline by default. The first session is created but no message is sent automatically.

All three resources must carry a versioned, OMA-owned onboarding metadata marker. On rerun, look up the marker in the active workspace and reuse compatible resources; if a prior resource is archived or incompatible, surface that state and create a new marked revision only after telling the operator what changed. Never identify user resources by display name alone.

## Failure contract

| Condition | Required behavior | Must not do |
| --- | --- | --- |
| Docker absent or daemon stopped | Stop before credential/state writes; explain the detected condition and recovery action. | Start a partial appliance or print generic stack traces. |
| Sandbox image absent | State the exact pinned image and that this is outside the warm-path timer; offer an explicit pull command or `--pull` confirmation. | Pull automatically without disclosure or count it as warm-path success. |
| Non-interactive terminal lacks required input | Fail fast with required flags/stdin contract. | Hang waiting for a prompt. |
| Invalid/empty credential input | Keep the operator at the credential step and mask it. | Echo, log, or place the key in an argument/URL. |
| Auth storage unsafe/unwritable | Stop with the backend's concrete safety diagnosis. | Fall back to world-readable files or browser storage. |
| Port occupied | Reuse a verified compatible appliance or choose a free loopback port. | Persist a first-boot credential before a bind succeeds. |
| Browser cannot open | Print the local console URL after bootstrap setup and keep the appliance healthy. | Treat browser launch as server startup failure. |
| Startup interrupted/fails | Close child processes and invalidate bootstrap state; report whether the provider credential was deliberately stored. | Leave a running orphan or a reusable console bootstrap token. |
| Provider rejects first real prompt | Show a secret-safe session error and one repair action. | Claim credential validation at onboarding completion. |

## Packaging and release milestones

### M1 — Packaged CLI contract

- Decide and reserve the npm package name and package ownership.
- Replace `private: true` only as part of an explicit release branch.
- Build or bundle a published runtime; do not rely on an unpublished checkout layout. The npm `files` allowlist must include only the CLI/runtime and the self-contained console assets it needs.
- Add `prepack` verification that records the tarball inventory and rejects unintended tests, local state, credentials, source-only paths required at runtime, or omitted console assets.
- Prove `npm pack` → fresh temporary project → installed `oma --version`, nested help, and read-only `oma doctor --json`.

### M2 — Guided local onboarding

- Implement the terminal adapter, preflight state machine, provider credential path, child-process lifecycle, bootstrap capability, and idempotent starter-resource creation.
- Add the local-console browser handoff and selected-session route.
- Keep all existing source-checkout commands and documentation valid.

### M3 — Acceptance and release channel

- Add a CI lane that installs the generated tarball in an empty directory, runs the TUI through a deterministic terminal adapter and local fixture provider, and exercises the actual browser console handoff against a cached sandbox image.
- Emit a timing artifact with the named start/end events and reject warm-path runs over 180 seconds. A separate cold-image record is required when the digest is absent.
- Publish only to the `next` channel after supply-chain/provenance requirements in #196 are implemented. Repeat the human warm-path study with at least three non-maintainer participants before promoting to `latest`.

curl and Homebrew work begins only after M1's package contract is proven; neither installer gets a separate runtime or a different onboarding state machine.

## Verification matrix

### Automated

- Unit: every state transition and each failure row; masked prompt never writes the secret to output; no TTY fallback; idempotent resource selection; child cleanup on signal.
- Security: stored credential modes/ownership/symlink rejection continue to pass; bootstrap is single-use, expires, is loopback-only, cannot access `/v1`, clears browser fragments, and does not appear in logs or persistent browser storage.
- Package: `npm pack` inventory, installation from the tarball into an empty project, npx entrypoint, Node-version rejection, uninstall/reinstall, and no install lifecycle side effects.
- Browser: actual console session is authenticated through bootstrap, selected session renders, reload retains only the opaque HttpOnly session, and no login/key form appears in the happy path.
- Runtime: Docker preflight and cached-image check, appliance health, starter agent/environment/session API operations, signal cleanup, existing `oma up` behavior, and source-checkout alpha browser/smoke gates.
- Performance: timestamped start at CLI invocation and finish at selected session ready; cached-image fixture must complete in ≤180 seconds. The report separately records package resolution, preflight, credential write, appliance readiness, resource creation, and browser handoff.

### Human gate

Run at least three non-maintainer participants on supported local machines with the stated warm prerequisites. Each run records only elapsed timings and blockers—never secrets, keys, screenshots containing keys, or durable IDs.

The public `next` onboarding gate passes only when:

- every successful run completes with zero undocumented intervention;
- median warm-path time is ≤3 minutes;
- all failures have a reproducible automated case or an explicitly documented out-of-scope cause; and
- no participant had to use `git clone`, `npm ci`, `npm link`, an exported provider-key environment variable, or manually paste a workspace key.

## Documentation changes at implementation time

Until M3, `README.md` and `docs/getting-started.md` continue to describe the source-checkout alpha path and must not advertise this command as shipped. Once `next` is verified, public documentation gets a short warm-prerequisites section, the one-command flow, the explicit cold-image branch, recovery guidance, and an advanced source-checkout path. The older 10-minute / 15-minute source-checkout observation protocol remains a historical alpha gate; public-install measurements belong in a separate results record so the two service levels are never conflated.

## Decisions required before implementation

1. Confirm the npm package name and whether its first public channel is `next` under the existing Elastic-2.0 license.
2. Choose the terminal prompt dependency after a small license/size/TTY-accessibility review, or keep a zero-dependency renderer. The public interaction contract above, not a dependency, is the requirement.
3. Review the console-bootstrap design against the local threat model before any route is added.
4. Decide whether the explicit `npx` command may offer `--pull` after displaying the missing image cost, or must always require a separately run pull command.

## Implementation order

1. Land M1 package closure and tarball CI with no public publish.
2. Land the terminal adapter and read-only preflight; prove no state writes on prerequisite failure.
3. Land provider credential persistence and model readiness using the existing auth backend.
4. Land appliance child lifecycle, secure console bootstrap, and starter-resource idempotency behind focused tests.
5. Add browser/performance gates and a new public-install observation record.
6. Run threat-model/adversarial review, publish `next`, then conduct the human gate before considering `latest`.
