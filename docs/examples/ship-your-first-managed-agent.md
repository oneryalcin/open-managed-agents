# Ship Your First Managed Agent

This example runs a local OMA compatibility probe for Anthropic's
`ship-your-first-managed-agent` workshop.

Source talk: https://www.youtube.com/watch?v=19HDQ9HppOA

It uses the real Python Anthropic SDK against a local OMA HTTP server, uploads
the workshop log file, creates a session with a mounted file resource, streams
events, lets the agent use Docker-local `bash`, lists replayed events, and
cleans up the session and uploaded file.

## What This Proves

The probe exercises:

```text
Python Anthropic SDK
  -> local OMA deployment control plane
  -> Files API upload with files-api-2025-04-14 beta
  -> session file-resource mount at /mnt/session/uploads/app.log
  -> Docker-local sandbox bash execution
  -> session event stream and replay
  -> session/file cleanup
```

It does not prove every future Managed Agents feature. In particular, the
workshop can be solved by log analysis alone, so a passing or useful run may
not call every custom tool in the sample.

## Prerequisites

- Node.js 22.19 or newer
- Docker or OrbStack running
- `ANTHROPIC_API_KEY` available
- Python dependency execution through `uv`
- workshop files checked out locally

Set `WORKSHOP_DIR` to your local checkout of the workshop:

```bash
export WORKSHOP_DIR=/path/to/cwc-workshops/ship-your-first-managed-agent
```

The probe reads workshop data from `OMA_SHIP_FIRST_WORKSHOP_DIR`.

## Start Local OMA

From the OMA repo root:

```bash
set -a
source "$WORKSHOP_DIR/.env"
set +a

OMA_SANDBOX_PROVIDER=docker-local \
OMA_ALLOW_DOCKER_LOCAL=true \
OMA_SHIP_FIRST_WORKSHOP_DIR="$WORKSHOP_DIR" \
OMA_PROBE_PORT=40178 \
npx tsx scratch/34-ship-first-agent-oma-server.ts
```

The server prints a ready line:

```json
{"ready":true,"port":40178,"base_url":"http://127.0.0.1:40178"}
```

## Run The Probe

In another shell, from the OMA repo root:

```bash
set -a
source "$WORKSHOP_DIR/.env"
set +a

OMA_SHIP_FIRST_WORKSHOP_DIR="$WORKSHOP_DIR" \
OMA_PROBE_BASE_URL=http://127.0.0.1:40178 \
uv run --with anthropic python scratch/34-ship-first-agent-oma-sdk-probe.py
```

To log the real SDK request method, URL, and relevant headers:

```bash
OMA_SHIP_FIRST_WORKSHOP_DIR="$WORKSHOP_DIR" \
OMA_PROBE_LOG_HTTP=true \
OMA_PROBE_BASE_URL=http://127.0.0.1:40178 \
uv run --with anthropic python scratch/34-ship-first-agent-oma-sdk-probe.py
```

To override the model:

```bash
OMA_SHIP_FIRST_WORKSHOP_DIR="$WORKSHOP_DIR" \
OMA_SHIP_FIRST_PROBE_MODEL=claude-opus-4-7 \
OMA_PROBE_BASE_URL=http://127.0.0.1:40178 \
uv run --with anthropic python scratch/34-ship-first-agent-oma-sdk-probe.py
```

## Expected Result

The probe emits labeled JSON sections such as:

```text
## agent.created
## environment.created
## file.uploaded
## session.created
## verdict
## session.deleted
## file.deleted
```

A strong run has:

- at least one `agent.tool_use` for `bash`
- replayed events from `sessions.events.list`
- final assistant text identifying the N+1 query pattern
- ideally the bad commit `a3f9c21`

The final `verdict.pass` follows the workshop-style check: it requires sandbox
tool use, N+1 diagnosis, and the bad commit. Model variance can produce a useful
API/sandbox compatibility run that still misses the commit string.

## Current Known Shape

This example drove two concrete compatibility fixes:

- `/v1/files` accepts the SDK's `files-api-2025-04-14` beta header.
- uploaded input files allow the workshop's larger `app.log` while staying
  explicitly bounded.
