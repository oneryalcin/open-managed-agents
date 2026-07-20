# Permission policies

> [!NOTE] Status: **Shipped alpha for built-in tools and MCP tools.**

Permission policies decide whether a tool call is automatically allowed or requires a human decision. They complement, rather than replace, the environment's filesystem and network boundaries.

## Policy types

| Policy | Behavior |
| --- | --- |
| `always_allow` | OMA runs the permitted tool without a confirmation prompt. |
| `always_ask` | OMA pauses the session and emits a confirmation request. |

Unknown policy types and duplicate built-in tool configuration are rejected before an agent is persisted. Omitted built-in tool configuration receives OMA's documented default policy.

## Respond to a confirmation

Use the session detail in the console, or send a `user.tool_confirmation` event through the API with `allow` or `deny`. Inspect the requested tool and input before allowing it.

> [!WARNING] OMA auto-denies an unanswered confirmation after five minutes. CMA documents indefinite waiting, so do not use the alpha for unattended long approval workflows.

## What a policy cannot grant

An allow decision cannot bypass the environment's immutable network policy, escape the sandbox, enable web tools, or expose vault secret values to the guest. It only resolves the pending tool action.
