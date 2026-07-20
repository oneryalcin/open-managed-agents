# Define your agent

> [!NOTE] Status: **Shipped alpha.** Agents are versioned, workspace-scoped configuration objects.

## Agent configuration

An agent selects an exact provider and model, system instructions, built-in tool configuration, skills, MCP servers, metadata, and a default confirmation policy. The model must be enabled by the appliance and have configured credentials before it can run a provider-backed session.

## Create an agent

Create an agent from the console or `POST /v1/agents`. The API validates built-in tool names and policies before persistence. Use the model catalog to discover deployment-enabled, credential-ready choices rather than assuming a hosted model name will work locally.

## Update semantics

Updating an agent creates a new immutable version with optimistic version checks. Existing sessions keep their originally selected version. Use the versions endpoint or console detail to inspect history.

## Agent lifecycle

List active agents by default, include archived agents only when the API requests them, and archive an agent when it should no longer begin new work. Archiving is an API-backed lifecycle action, not a browser-only label.

## What an agent does not define

An agent does not grant network access, choose arbitrary images, or make a sandbox healthy. Those properties belong to the [environment](#docs=environments) and are exercised only when a session runs.
