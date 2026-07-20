# Tools

> [!NOTE] Status: **Shipped alpha for the bounded coding toolset.**

## Available tools

OMA supports `bash`, `read`, `write`, `edit`, `glob`, and provider-owned `grep` for the supported local providers. The pinned coding image contains Node/npm, Python/uv, Git, curl, jq, archive tools, and a basic native build baseline.

## Configure a toolset

Tool configuration lives on the agent. OMA validates known built-in names, rejects duplicate configuration, and supports `always_allow` and `always_ask` policies. Use [Permission policies](#docs=permissions) for the review workflow and timeout boundary.

## Custom tools

Custom-tool calls are persisted as events and wait for a `user.custom_tool_result` response from the API client. They are not an invitation to run arbitrary code in the browser or appliance host.

## Web tools

> [!WARNING] `web_fetch` and `web_search` are disabled. Approved Docker egress permits only the environment's HTTPS allowlist; it does not turn host-network access into provider-owned web tools.

## Related resources

Use [Files](#docs=files) for mounts and output, [Skills](#docs=skills) for reusable bundles, and [MCP connector](#docs=integrations) for external tool servers.
