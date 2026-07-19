# Getting Started

This is the canonical alpha setup path for Open Managed Agents from a source
checkout. It is intentionally source-first: public npm, `npx`, curl installer,
and Homebrew distribution are release and supply-chain work tracked separately
in GitHub issue #196.

The goal is a working local appliance you can open in the browser:

```text
clone repo
  -> npm ci
  -> link the local oma CLI
  -> run read-only diagnostics
  -> run the no-paid-API smoke
  -> start OMA
  -> log in with a workspace key
  -> create agent, environment, session
  -> send a prompt and inspect events
```

## Prerequisites

- Node.js 22.19 or newer.
- Docker or OrbStack running.
- A shell where `npm` can install the locked dependencies.
- Optional: a model credential such as `ANTHROPIC_API_KEY` for the
  credentialed console flow.

Docker is the recommended alpha sandbox provider. It is used explicitly by
`oma up` and the local-compatible smoke; it is not an implicit runtime fallback
inside the API.

## Install From A Checkout

```bash
git clone https://github.com/oneryalcin/open-managed-agents.git
cd open-managed-agents
npm ci
npm link
```

Check CLI discovery before starting services:

```bash
oma --help
oma doctor
```

`oma doctor` is read-only and secret-safe. It must not create `~/.oma`, auth
files, locks, databases, or pull Docker images. It reports readiness and exits:

At this point a missing default-provider credential is an expected warning,
not a failure. You can run the local-compatible proof below without a paid
credential; configure a real credential before the durable console flow.

| Exit code | Meaning |
| --- | --- |
| `0` | No readiness failures. |
| `1` | One or more local readiness checks failed. |
| `2` | Invalid doctor invocation or an internal diagnostic failure. |

For automation:

```bash
oma doctor --json
```

## Prove The Local Runtime Without A Paid API

Run the deterministic local-compatible smoke:

```bash
oma smoke --local-compatible
```

This starts an isolated temporary OMA server, a loopback OpenAI-compatible
model fixture, and a Docker-local sandbox. It verifies:

- model discovery for a custom provider/model pair;
- agent, environment, and session creation;
- a real `bash` tool call inside Docker;
- public tool/result/message events;
- cleanup of temporary state.

Use this as the first health proof before configuring paid provider
credentials.

## Start The Appliance

For the default Anthropic path, set the model credential before starting:

```bash
export ANTHROPIC_API_KEY="..."
oma up
```

`oma up` runs the durable local appliance in the foreground, stores data under
`~/.oma`, enables Docker-local sandboxing, and prints:

- the API URL;
- the console URL;
- the first workspace API key, exactly once.

Keep this terminal open. Open the console shown in the startup output, usually:

```text
http://127.0.0.1:4180/console
```

If the first workspace key was not saved, mint another from a second terminal
while `oma up` is still running:

```bash
oma keys mint
```

## Log In And Run A Session

In the console:

1. Choose **Workspace** login.
2. Paste the workspace API key.
3. Open **Start**.
4. Confirm model credential readiness for the selected model.
5. Create an agent.
6. Create an environment.
7. Create a session.
8. Send a prompt.
9. Inspect the transcript, tool calls, tool results, files, and errors.

Sandbox readiness is verified by the actual session run. The console should not
claim generic sandbox health before a session exercises the provider.

## Use Another Model Provider

OMA reuses Pi's provider catalog and request adapters. Anthropic, OpenAI, and
OpenRouter are enabled for discovery by default; a provider still cannot run a
session until its credentials are configured. For OpenAI:

```bash
oma auth set openai
oma auth status openai
oma models list --provider openai --available
oma up
```

Use `OMA_MODEL_PROVIDERS` to narrow the deployment or add another Pi provider;
it replaces the default allowlist rather than extending it.

Restart `oma up` after `oma auth` changes. During alpha, the running appliance
does not promise hot reload of credential mutations.

For operator-defined OpenAI-, Anthropic-, or Google-compatible endpoints, use
Pi's `models.json` format at `~/.oma/pi/models.json` or
`OMA_PI_MODELS_FILE`, then validate before starting:

```bash
oma models validate
```

See [Development and deployment setup](dev-deployment.md#model-providers-and-custom-compatible-endpoints)
for support tiers and a local-compatible example.

## Admin Mode

Workspace login is enough for the normal alpha path. Appliance-wide admin mode
is opt-in:

```bash
oma admin init
oma admin status
```

`oma admin init` writes `~/.oma/admin.key` with mode `0600` and prints the
admin key once. Restart `oma up` after initialization. Admin mode is for
creating workspaces and minting/revoking workspace keys from the browser or
admin API.

## Common First-Run Failures

| Symptom | Check |
| --- | --- |
| `oma` command not found | Run `npm link` from the checkout, or use `node bin/oma.mjs ...` directly. |
| Docker errors | Start Docker or OrbStack, then run `docker info`. |
| Missing model credentials | Run `oma doctor`, `oma auth status PROVIDER`, and `oma models list --provider PROVIDER --available`. Restart after credential changes. |
| Port already in use | Set `OMA_PORT=...` before `oma up`. |
| Session rejects model | Confirm the provider is enabled, the model exists, and credentials are configured. OMA fails closed rather than falling back to a different model. |
| Console login fails | Use a workspace key for ordinary workspace operations. Use the admin key only for admin routes. |
| Networking fails inside the sandbox | Environment networking is default-deny unless explicitly configured. |

## What This Does Not Cover

- Public package installation through npm, `npx`, curl, or Homebrew.
- Full hosted Claude Managed Agents parity.
- Multi-agent runtime, memory stores, scheduled deployments, webhooks, and
  outcomes.
- Pixel-perfect console parity with hosted CMA.

See [ALPHA.md](../ALPHA.md) for the alpha readiness worklist and
[PARITY.md](../PARITY.md) for the product parity tracker.
