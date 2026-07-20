# Get started with OMA

> [!NOTE] Status: **Canonical alpha path.** This flow installs from a source checkout; public package installers and Homebrew are not available yet.

## Prerequisites

Use Node.js 22.19 or newer and Docker or OrbStack. A model credential is optional for the deterministic local proof and required for a real provider-backed session.

## Install and diagnose

```
git clone https://github.com/oneryalcin/open-managed-agents.git
cd open-managed-agents
npm ci
npm link
oma doctor
```

`oma doctor` is read-only and secret-safe. A missing provider credential is a warning for the local-compatible proof, not a reason to skip it.

## Prove the local runtime

```
oma smoke --local-compatible
```

The smoke starts isolated temporary services, uses a local-compatible model fixture, executes a real Docker tool call, observes public events, and cleans up afterward.

## Start the appliance

```
export ANTHROPIC_API_KEY="…"
oma up
```

Startup prints the API URL, console URL, and first workspace key once. Keep the appliance process running while you use it. Other supported provider credentials can be configured with the `oma auth` and `oma models` commands described in the repository's Getting Started guide.

## Create your first session

1. **Sign in with a workspace key.** The key is exchanged for an opaque, revocable console session, so a reload restores the workspace without storing the key in the browser.
2. **Create an agent.** Select a credential-ready model and choose its tools and confirmation policy.
3. **Create an environment.** Start Offline unless the work requires an approved HTTPS allowlist.
4. **Create a session and send a prompt.** Inspect the event stream, tool calls, results, confirmations, output files, and errors.

## What's happening

OMA persists the agent version selected for the session, creates the sandbox state required by its environment, and records events in a durable session log. Sandbox readiness is proved by a real tool call, not guessed by the browser.

## Next steps

Read [Agent setup](#docs=agents), [Environments](#docs=environments), and [Session event stream](#docs=events). For a deterministic proof of supported network behavior, run `oma smoke --egress`.
