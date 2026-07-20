# Self-hosted sandboxes

> [!WARNING] Status: **Not a CMA-compatible feature in v1.** OMA is a self-hosted appliance, but it does not implement CMA's remote self-hosted worker protocol or custom-tool tunnels.

## What OMA supports now

The local appliance runs sessions through its configured local sandbox provider. Docker-local is the recommended alpha provider. Microsandbox-local is available for offline execution only.

## What is not available

OMA has no worker registration, remote queue, tunnel, externally hosted custom-tool service, or caller-submitted sandbox result protocol. Do not point an external worker at the session API expecting CMA self-hosted sandbox semantics.

## Operator guidance

Run the appliance on infrastructure you control, keep the workspace and API keys private, and use the supported local smoke commands before admitting real workloads. A future remote-worker architecture must preserve the same default-deny network and secret-boundary guarantees.
