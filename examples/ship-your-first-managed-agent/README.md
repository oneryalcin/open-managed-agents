# OMA Ship Your First Managed Agent

This example adapts Anthropic's `ship-your-first-managed-agent` workshop to a
local Open Managed Agents deployment.

Source talk: https://www.youtube.com/watch?v=19HDQ9HppOA

This example is repo-local: `oma-server.ts` imports OMA source directly and
should be run from this repository root.

It keeps the workshop's incident dashboard shape: metrics, logs, deploys, and
a Streamlit SRE agent panel. The agent panel uses the real Python Anthropic SDK,
but points it at a local OMA HTTP server.

## What It Exercises

```text
Streamlit dashboard / Python Anthropic SDK
  -> local OMA deployment control plane
  -> uploaded app.log file resource
  -> Docker-local sandbox materialization
  -> sandboxed bash/read/find execution
  -> local custom tools over the event stream
  -> event replay and cleanup
```

The custom tools are:

- `get_metrics`
- `get_recent_deploys`
- `get_diff`

## Prerequisites

- Node.js 22.19 or newer
- Docker or OrbStack running
- Python 3.10 or newer
- `uv`
- `ANTHROPIC_API_KEY`

## 1. Configure Python

From this example directory:

```bash
cd examples/ship-your-first-managed-agent
cp .env.example .env
```

Edit `.env` and set `ANTHROPIC_API_KEY`.

## 2. Start Local OMA

From the repository root:

```bash
set -a
source examples/ship-your-first-managed-agent/.env
set +a

OMA_SANDBOX_PROVIDER=docker-local \
OMA_ALLOW_DOCKER_LOCAL=true \
OMA_PROBE_PORT=40178 \
npx tsx examples/ship-your-first-managed-agent/oma-server.ts
```

The server prints:

```json
{"ready":true,"port":40178,"base_url":"http://127.0.0.1:40178"}
```

## 3. Run The Dashboard

In another shell:

```bash
cd examples/ship-your-first-managed-agent
set -a
source .env
set +a

uv run \
  --with-requirements requirements.txt \
  streamlit run app.py
```

Open the Streamlit URL. Click `+` in the SRE Agent panel to create a session,
then ask:

```text
checkout p99 spiked around 14:32 UTC. Find the root cause.
```

The agent should inspect `/mnt/session/uploads/app.log`, call local custom
tools, and identify commit `a3f9c21` as the N+1 query regression.

## 4. Run The Headless Smoke

The smoke is the repeatable proof path for #82:

```bash
cd examples/ship-your-first-managed-agent
set -a
source .env
set +a

uv run --with-requirements requirements.txt python smoke.py
```

A passing run emits `## verdict` with:

- `pass: true`
- at least one sandbox `agent.tool_use`
- `agent.tool_result`
- all custom tools: `get_metrics`, `get_recent_deploys`, `get_diff`
- `user.custom_tool_result`
- `a3f9c21`
- N+1 diagnosis

## Notes

- This example intentionally uses Docker-local because OMA's host-passthrough
  provider does not materialize session file resources.
- The dashboard creates local OMA resources. Use the delete button in the
  session picker or run the smoke, which cleans up its session and uploaded
  file automatically.
- Model behavior can vary. The smoke prompt is stricter than casual dashboard
  prompts so it reliably exercises the custom tools.
