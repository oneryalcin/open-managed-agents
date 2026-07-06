# Probe 46 — `@modelcontextprotocol/sdk@1.29.0` client surface (plan 0122)

Run 2026-07-06, Node v24.18.0, SDK 1.29.0. Script: `46-mcp-sdk-client-probe.mjs`.

## Captured output

```
server at http://127.0.0.1:57433/mcp
server info: {"name":"probe-server","version":"0.0.1"}
tools: [{"name":"echo","schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"$schema":"http://json-schema.org/draft-07/schema#"}},{"name":"boom","schema":{"type":"object","properties":{},"$schema":"http://json-schema.org/draft-07/schema#"}},{"name":"errresult","schema":{"type":"object","properties":{},"$schema":"http://json-schema.org/draft-07/schema#"}}]
callTool ok: {"content":[{"type":"text","text":"echo: hi"}]}
unknown tool: NO THROW -> {"content":[{"type":"text","text":"MCP error -32602: Tool does-not-exist not found"}],"isError":true}
schema-invalid args: NO THROW -> {"content":[{"type":"text","text":"MCP error -32602: Input validation error: Invalid arguments for tool echo: [...]"}],"isError":true}
tool throws internally: NO THROW -> {"content":[{"type":"text","text":"tool crashed internally"}],"isError":true}
tool returns isError: NO THROW -> {"content":[{"type":"text","text":"explicit tool error"}],"isError":true}
protocol-level (tools/bogus): THREW -> McpError MCP error -32601: Method not found
```

## What this pins down

1. **Client API** (plan §3.4): `Client` + `StreamableHTTPClientTransport(url, {requestInit})`
   connect / `listTools()` / `callTool({name, arguments})` all work over
   streamable HTTP; `requestInit.headers.authorization` rides every request
   (the M2 `static_bearer` seam). `fetch?: FetchLike` also exists in the
   shipped transport options (the SSRF seam) — see the transport `.d.ts`.
2. **`listTools().tools[].inputSchema` is plain JSON Schema draft-07.**
3. **Error classes** (plan §4.4 step 6): unknown tool, schema-invalid
   arguments, and a tool handler throwing internally **all resolve normally
   with `{isError: true}`** — `callTool` does not throw for any in-band
   failure. Only protocol-level failures (unknown JSON-RPC method here;
   transport drop / timeout in production) **reject**. The two classes need
   distinct handling and distinct test fixtures.
4. **Fixture note:** `StreamableHTTPServerTransport` in stateless mode
   (`sessionIdGenerator: undefined`) expects a transport per request; test
   fixtures use stateful mode (`sessionIdGenerator` returning an id).
