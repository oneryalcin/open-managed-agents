# API reference and compatibility

> [!NOTE] Status: **Shipped alpha reference.** The OpenAPI schema is the wire-contract authority.

Use the console for guided operations and the bundled [OpenAPI reference](/docs/) for endpoint-level integration details. The machine-readable schema is available at `/openapi.json`.

## Authentication and errors

Managed-agent API requests are workspace-scoped and require a workspace key plus the managed-agents beta header. Successful POST operations use the documented API response shape; errors use a structured envelope with a request ID. Use the schema rather than this guide as the field-level authority.

## Shipped alpha scope

| Area | Current behavior |
| --- | --- |
| Agents | Create, retrieve, list, immutable update/version history, and archive. |
| Environments | Create, retrieve, list, safe networking presets, and custom-host validation. No archive/delete yet. |
| Sessions | Create, retrieve, list with bidirectional cursors, archive/delete when idle, send events, list events, and SSE resume. |
| Tools | Bounded coding tools, tool confirmations, custom-tool result events, files, skills, MCP, and supported vault credentials. |
| Console | Real API-backed alpha workflow and interactive OpenAPI documentation. |

## Deliberate differences and deferred surfaces

OMA is not a complete hosted CMA implementation. It currently lacks web tools, memory, dreams, outcomes, GitHub repository resources, webhooks, scheduled deployments, multi-agent threads, per-session overrides, live session updates, streaming token previews, and broad hosted-provisioning options. The corresponding pages in this guide explain each boundary.

## Source of truth

This documentation is a user guide. The appliance's OpenAPI schema is authoritative for wire contracts, while the repository's `PARITY.md` records evidence-backed compatibility work and known differences. When those sources change, this guide must be updated before the console advertises a new capability.
