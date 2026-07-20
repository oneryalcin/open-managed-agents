# Open Managed Agents overview

Open Managed Agents (OMA) is a local-first appliance for creating, running, and inspecting managed-agent workflows on infrastructure you control.

> [!NOTE] Status: **Alpha.** This guide describes behavior that ships in OMA. Where CMA offers a broader feature, OMA names the boundary rather than implying parity.

## Start here

- [Quickstart](#docs=quickstart) — install from a checkout, prove the local runtime, and start the appliance.
- [Prototype in Console](#docs=console) — create a real agent, environment, session, and prompt from the browser.
- [Start a session](#docs=sessions) — understand the persisted work unit.
- [API reference and compatibility](#docs=reference) — use exact endpoint contracts and see current differences.

## Core concepts

| Concept | OMA meaning |
| --- | --- |
| Agent | A versioned model, instruction, tool, MCP-server, and skill configuration. |
| Environment | An immutable sandbox and networking policy selected before a session runs. |
| Session | A persisted run of one agent in one environment. |
| Event | A persisted user, tool, agent, model-span, status, or error record that can be listed or streamed. |
| Vault | A workspace credential container for supported integrations. |

## How it works

1. **Create an agent.** Select a configured provider and model, instructions, capabilities, and tool-confirmation policy.
2. **Create an environment.** Keep it offline or choose a bounded HTTPS allowlist before work begins.
3. **Start a session.** Select the agent and environment, attach allowed resources, and send a user event.
4. **Inspect and steer.** Read persisted events, respond to confirmations, interrupt work, and inspect outputs.

## When to use OMA

Use OMA when you want a self-hosted, inspectable, synchronous single-agent coding workflow with explicit sandbox and network boundaries. It is an alpha appliance, not a hosted long-running automation platform.

## Supported tools

The current coding path provides Bash, read, write, edit, glob, and provider-owned grep in a pinned local image. Files, custom skills, MCP servers, and vault credentials are available within their documented boundaries. [Web fetch and web search](#docs=tools) are not enabled.

## Beyond v1

Memory, dreams, outcomes, multi-agent orchestration, GitHub repository resources, scheduled deployments, and webhooks have dedicated pages in this guide. They are intentional **not-ready-in-v1** states, not hidden controls.
