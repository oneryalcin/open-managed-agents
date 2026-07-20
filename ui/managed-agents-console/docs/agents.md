# Agent setup

Agents hold the reusable, versioned instructions and capabilities that sessions run.

## What belongs in an agent

An agent selects a model and system prompt, and can include built-in tools, attached skills, and MCP configuration. Updating an agent creates a new immutable version; existing sessions keep the version they started with.

## Tool confirmation

Choose whether tool use requires confirmation or is automatically allowed. This policy is not a sandbox escape hatch: the environment still controls filesystem and network boundaries.

> [!WARNING] A session awaiting tool confirmation is not automatically approved by the console. Review the tool request and explicitly allow or deny it. If no decision arrives within five minutes, OMA automatically denies the request; this differs from CMA's indefinite wait.

## Model readiness

The console reports configured credentials from the live model catalog. A model cannot run until its provider credential is configured; browser-visible readiness is not a claim that a sandbox run has succeeded.
