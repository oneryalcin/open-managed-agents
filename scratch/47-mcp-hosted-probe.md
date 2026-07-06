# Probe 47 — hosted Managed Agents MCP connector (plan 0122 M1)

Run 2026-07-07 against api.anthropic.com (`managed-agents` beta, model
`claude-sonnet-5`), public no-auth DeepWiki MCP server
(`https://mcp.deepwiki.com/mcp`). Script: `47-mcp-hosted-probe.py`.

## Validation parity (agent create)

| Case | Hosted | OMA M1 | Verdict |
|---|---|---|---|
| Dangling `mcp_toolset` (no server) | **400** — `references server "deepwiki" which is not defined in mcp_servers` | 400 | parity ✓ |
| Unreferenced server (no toolset) | **400** — `mcp_servers [deepwiki] declared but no mcp_toolset in tools references them` | 400 | parity ✓ |
| Two `mcp_toolset`s, same server | **400** — `duplicate entry for server "deepwiki"; each MCP server may have at most one mcp_toolset` | 400 | **parity ✓ — NOT an OMA tightening** (plan §4.1 open item resolved) |
| URL with embedded `user:pass@` | **ACCEPTED** (agent created) | 400 | **OMA deviation, deliberate** — security posture (plan §4.1 relabeled) |

## Allow flow (`default_config.permission_policy: always_allow`)

Raw frames (exact):

```json
{ "id": "sevt_01DJPjkRfJqxgamSDkNtxi3s",
  "type": "agent.mcp_tool_use",
  "mcp_server_name": "deepwiki",
  "name": "read_wiki_structure",          // BARE tool name on the wire
  "input": { "repoName": "badlogic/pi-mono" },
  "evaluated_permission": "allow",
  "session_thread_id": null, "processed_at": "…" }

{ "id": "sevt_01HA2aQ5dyY1tmzjGzjW1NDy",
  "type": "agent.mcp_tool_result",
  "mcp_tool_use_id": "sevt_01DJPjkRfJqxgamSDkNtxi3s",   // = use event's id
  "content": [ { "type": "text", "text": "{\"result\":\"Available pages…\"}" } ],
  "is_error": false }
```

## Default (ask) flow — no `permission_policy` configured

- `agent.mcp_tool_use` arrives with `evaluated_permission: "ask"` — the
  documented `always_ask` default is real.
- `session.status_idle` `stop_reason: { type: "requires_action",
  event_ids: ["<the mcp_tool_use sevt id>"] }`.
- Confirmation is sent as **`user.tool_confirmation`** (the bare
  `tool_confirmation` in the claude-api skill docs is REJECTED:
  `events[0].type: "tool_confirmation" is not a valid value`).
- After allow: `agent.mcp_tool_result` with `mcp_tool_use_id` correlation,
  `is_error: false`.

## Conclusions for OMA M1

Every emitted field and correlation matches OMA's implementation: bare tool
name + `mcp_server_name` in events (the model-visible name is not
observable on the wire — open Q1 stays a non-wire concern), top-level
`sevt_*` correlation, `always_ask` default, requires_action shape,
`user.tool_confirmation` round-trip. Content arrives as text blocks
(DeepWiki returns a JSON string in one text block), consistent with M1's
text-passthrough mapping.

Two plan dispositions: duplicate-toolset rejection relabeled parity;
userinfo-URL rejection relabeled deliberate OMA deviation.
