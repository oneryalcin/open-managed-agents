# Quickstart

Use this path to prove a local OMA checkout, then create the first live session from the console.

## Prerequisites

Use Node.js 22.19 or newer and a running Docker or OrbStack installation. A model credential is optional for the deterministic local proof and required for a credential-backed model session.

## Install and verify

```
git clone https://github.com/oneryalcin/open-managed-agents.git
cd open-managed-agents
npm ci
npm link
oma doctor
oma smoke --local-compatible
```

The smoke starts isolated temporary services, uses a local-compatible model fixture, executes a real Docker tool call, and cleans up afterward.

## Start OMA

```
export ANTHROPIC_API_KEY="…"
oma up
```

Startup prints the local console URL and first workspace key once. Keep the appliance running while you use the console.

## Complete the console path

1. **Connect with a workspace key.** Keys stay in page memory and are requested again after a reload.
2. **Create an agent and environment.** Confirm the model is credential-ready and keep networking offline unless the task needs an approved allowlist.
3. **Create a session and send a prompt.** Use its event stream to inspect tool calls, results, confirmations, and errors.
