# Open Managed Agents overview

A local-first managed-agent appliance for creating, running, and inspecting agents on infrastructure you control.

> [!NOTE] OMA is an alpha. This guide describes shipped behavior; unavailable CMA capabilities are named plainly rather than implied.

## Start here

- [Quickstart](#docs=quickstart) — install from a checkout, prove the local runtime, and open the console.
- [Sessions and events](#docs=sessions) — create a session, send a prompt, and inspect its evidence.
- [API and alpha scope](#docs=reference) — find the OpenAPI reference and current boundaries.

## Core concepts

| Concept | OMA meaning |
| --- | --- |
| Agent | Versioned model, prompt, tool, MCP-server, and skill configuration. |
| Environment | Immutable sandbox and networking policy for a session. |
| Session | A persisted agent run that receives events and produces transcript, tool, and file evidence. |
| Events | User messages, tool activity, agent messages, errors, and confirmation state streamed over SSE. |

## How the workflow fits together

1. **Create an agent.** Choose a configured provider/model, its instruction, capabilities, and tool-confirmation policy.
2. **Create an environment.** Pick the sandbox policy before starting work; network grants are explicit and immutable.
3. **Start a session.** Attach the selected agent and environment, then send a task as a session event.
4. **Inspect and steer.** Follow persisted events, answer tool confirmations, interrupt work when needed, and inspect produced files.

## Alpha boundaries

OMA supports the synchronous, single-agent workflow. It does not currently offer web search/fetch, hosted cloud-sandbox breadth, scheduled deployments, persistent memory, outcomes, webhooks, or multi-agent orchestration.
