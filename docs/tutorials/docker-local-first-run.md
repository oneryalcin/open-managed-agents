# First Docker-Local Run

This guide runs Open Managed Agents with the Docker-local sandbox provider.

It is a developer quickstart for the current MVP: one local control-plane run,
one model-driven bash tool call, and a Docker container that is created,
used, and cleaned up.

## What This Proves

The run exercises the real deployment path:

```text
OMA_* deployment config
  -> createDeploymentControlPlaneApp / PiSessionRunner
  -> Docker-local sandbox provider
  -> bash executes in /workspace
  -> agent.tool_use / agent.tool_result events
```

It does not prove full Anthropic Managed Agents tutorial parity yet. File
resources are supported on the Docker-local path, but this smoke does not
exercise uploads or `/mnt/session/uploads` materialization; use
`scratch/27-file-resource-docker-materialization.ts` for that path. Permission
prompts and durable custom-tool recovery are implemented on their own API paths;
managed remote providers are still tracked separately.

## Prerequisites

- Node.js 22.19 or newer
- Docker or OrbStack running
- credentials for the selected model provider (`ANTHROPIC_API_KEY` for the
  default Anthropic quickstart, or `oma auth set PROVIDER` plus a restart)

Check the basics:

```bash
npm install
npm run typecheck
npm test
docker info
test -n "$ANTHROPIC_API_KEY"
```

## Run The Smoke

From the repo root:

```bash
npx tsx scratch/23-e3-deployment-docker-smoke.ts
```

The probe configures Docker-local through the same deployment config shape an
operator would use:

```text
OMA_SANDBOX_PROVIDER=docker-local
OMA_ALLOW_DOCKER_LOCAL=true
```

It also runs a host-passthrough negative control. That matters because
`IN_DOCKER=yes` and `PWD=/workspace` are only meaningful if the same command
prints `IN_DOCKER=no` and a host temp directory outside Docker.

## Expected Result

A successful run ends with:

```json
{
  "verdict": "PASS",
  "discriminator": {
    "discriminator_is_real": true
  },
  "served": {
    "tool_use_count": 1,
    "tool_result_count": 1,
    "tool_name": "bash",
    "command_exact": true,
    "tool_use_id_match": true,
    "is_error": false,
    "tool_result_text_exact": true,
    "pass": true
  },
  "cleanup": {
    "leftover_containers_after_close": [],
    "cleaned_up": true
  }
}
```

The important line in the tool result is:

```text
IN_DOCKER=yes PWD=/workspace
```

The negative control should show:

```text
IN_DOCKER=no PWD=<host temp directory>
```

## Manual Deployment Config

If you are wiring your own server entrypoint, use the deployment app
constructor:

```ts
import { serve } from "@hono/node-server";
import { createDeploymentControlPlaneApp } from "./src/control-plane/app.ts";

const app = createDeploymentControlPlaneApp(process.env);

serve({
  fetch: app.fetch,
  port: 3000,
});
```

Then run it with:

```bash
OMA_SANDBOX_PROVIDER=docker-local \
OMA_ALLOW_DOCKER_LOCAL=true \
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
npx tsx server.ts
```

Docker-local is default-closed. If `OMA_ALLOW_DOCKER_LOCAL=true` is missing,
the app fails during construction instead of silently running tools on the
host.

Docker-local also enables a label-scoped orphan-container reaper by default.
It removes stale Open Managed Agents Docker-local containers older than 24
hours before the first Docker-local session starts in the process. Override
that age only when you need a different local durability posture:

```bash
OMA_DOCKER_REAP_STALE_CONTAINERS_OLDER_THAN_MS=86400000
```

## Troubleshooting

- `Docker-local sandbox provider is disabled by deployment configuration`
  means `OMA_SANDBOX_PROVIDER=docker-local` was set without
  `OMA_ALLOW_DOCKER_LOCAL=true`.
- `docker info` must work before the Docker-local provider can start.
- If the smoke fails before model output, confirm `ANTHROPIC_API_KEY` is set in
  the shell running the command. For another enabled provider, run
  `oma auth status PROVIDER` and
  `oma models list --provider PROVIDER --available`, then restart `oma up`
  after credential changes.
- If a run is interrupted, the probe attempts to remove labelled containers for
  its session before exiting.
