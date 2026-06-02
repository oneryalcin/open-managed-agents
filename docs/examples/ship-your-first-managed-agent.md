# Ship Your First Managed Agent

This example adapts Anthropic's `ship-your-first-managed-agent` workshop to a
local OMA deployment.

Source talk: https://www.youtube.com/watch?v=19HDQ9HppOA

The runnable example lives in:

```text
examples/ship-your-first-managed-agent/
```

It includes:

- Streamlit incident dashboard
- local fixture data for metrics, logs, deploys, and diffs
- OMA-backed `agent.py` using the real Python Anthropic SDK
- example-local OMA server entrypoint
- headless Docker-local smoke script

## What This Proves

The dashboard and smoke exercise:

```text
Python Anthropic SDK
  -> local OMA deployment control plane
  -> Files API upload
  -> session file-resource mount at /mnt/session/uploads/app.log
  -> Docker-local sandbox execution
  -> local custom tools over the event stream
  -> event listing/replay
  -> session/file cleanup
```

The smoke verifies all three workshop custom tools:

- `get_metrics`
- `get_recent_deploys`
- `get_diff`

## Run It

Use the example README for commands:

[examples/ship-your-first-managed-agent/README.md](../../examples/ship-your-first-managed-agent/README.md)

The short version is:

1. Create `examples/ship-your-first-managed-agent/.env` from `.env.example`.
2. Start local OMA with Docker-local:

   ```bash
   OMA_SANDBOX_PROVIDER=docker-local \
   OMA_ALLOW_DOCKER_LOCAL=true \
   OMA_PROBE_PORT=40178 \
   npx tsx examples/ship-your-first-managed-agent/oma-server.ts
   ```

3. Run the dashboard:

   ```bash
   cd examples/ship-your-first-managed-agent
   uv run --with-requirements requirements.txt streamlit run app.py
   ```

4. Or run the headless smoke:

   ```bash
   cd examples/ship-your-first-managed-agent
   uv run --with-requirements requirements.txt python smoke.py
   ```

## Current Boundary

This example intentionally uses Docker-local because OMA's host-passthrough
provider does not materialize session file resources. The smoke is therefore an
explicit integration check, not part of the normal unit test suite.
