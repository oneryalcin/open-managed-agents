# MCP connector

> [!NOTE] Status: **Shipped alpha for supported MCP servers and vault-backed authentication.**

## Declare MCP servers on an agent

Configure an MCP server in the agent's versioned configuration. OMA resolves it when the session starts and records MCP tool use and result events in the session history.

## Configure available tools

MCP tools remain subject to the agent's permission policy. Inspect the session event stream to see evaluation, confirmation, execution, and result behavior rather than treating a configured server as proof that every tool is usable.

## Provide authentication

Attach the needed [vault](#docs=vaults) at session creation. OMA supports the shipped static-bearer and MCP OAuth flows, including configured validation. Credentials are not rendered as plaintext in the console or passed as ordinary browser data.

## Current boundaries

OMA does not provide MCP tunnels, arbitrary rich content blocks, or long-output spill-to-file behavior. It also does not provide generic environment-variable credential injection.
