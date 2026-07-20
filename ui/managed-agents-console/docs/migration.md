# Migration

> [!NOTE] Status: **Partial alpha guidance.** OMA borrows the managed-agent resource model, but it is not a drop-in replacement for every hosted CMA feature.

## From a custom agent loop

Move durable configuration into an agent, choose an environment before execution, create a session for each persisted run, and consume the session event log over HTTP or SSE. OMA owns the local runtime bridge, sandbox lifecycle, persisted transcript, and tool-confirmation state.

You still own model-provider credentials, appliance operation, workspace-key distribution, and any application UI or job queue around OMA.

## Compatibility boundary

Start from the synchronous single-agent path: agent, environment, session, user event, and persisted event stream. Check [API reference and compatibility](#docs=reference) before depending on a request shape or lifecycle detail.

## Features not to assume

Per-session agent overrides, live session updates, hosted provisioning, memory stores, outcomes, webhooks, GitHub repository resources, scheduled deployments, and multi-agent threads are not part of the current alpha. Use the dedicated deferred pages for their current status rather than designing against hosted-only behavior.
