// Probe 46 — @modelcontextprotocol/sdk client surface for plan 0122 (M1).
// Captured output: scratch/46-mcp-sdk-client-probe.md
//
// Not a repo dependency yet; run with:
//   npm install --no-save @modelcontextprotocol/sdk@1.29.0 zod && node scratch/46-mcp-sdk-client-probe.mjs
//
// What this pins down (plan 0122 §3.4, §4.4 step 6):
// 1. Client API: connect / listTools / callTool over streamable HTTP, with
//    requestInit header injection (the M2 static_bearer seam).
// 2. listTools inputSchema is plain JSON Schema (draft-07).
// 3. Error classes: unknown tool, schema-invalid args, and a tool throwing
//    internally ALL resolve with {isError: true} — callTool does NOT throw
//    for in-band failures. Only protocol-level failures reject.
// 4. Server-side note: StreamableHTTPServerTransport in stateless mode
//    (sessionIdGenerator: undefined) needs a transport per request; test
//    fixtures use stateful mode.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "node:http";
import { z } from "zod";

const mcp = new McpServer({ name: "probe-server", version: "0.0.1" });
mcp.registerTool(
  "echo",
  { description: "Echoes back the input", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);
mcp.registerTool("boom", { description: "throws", inputSchema: {} }, async () => {
  throw new Error("tool crashed internally");
});
mcp.registerTool("errresult", { description: "isError result", inputSchema: {} }, async () => ({
  isError: true,
  content: [{ type: "text", text: "explicit tool error" }],
}));

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => "probe-session-1",
});
await mcp.connect(transport);
const http = createServer(async (req, res) => {
  let body;
  if (req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = JSON.parse(Buffer.concat(chunks).toString() || "null");
  }
  await transport.handleRequest(req, res, body);
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${http.address().port}/mcp`;
console.log("server at", url);

// --- client side (what the OMA control plane does) ---
const client = new Client({ name: "oma-probe", version: "0.0.1" });
const clientTransport = new StreamableHTTPClientTransport(new URL(url), {
  // M2 static_bearer seam: per-connection header injection.
  requestInit: { headers: { authorization: "Bearer test-token" } },
});
await client.connect(clientTransport);
console.log("server info:", JSON.stringify(client.getServerVersion()));

const tools = await client.listTools();
console.log(
  "tools:",
  JSON.stringify(tools.tools.map((t) => ({ name: t.name, schema: t.inputSchema }))),
);

const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
console.log("callTool ok:", JSON.stringify(result));

// Error-class matrix: none of these throw; all resolve with isError:true.
for (const call of [
  { label: "unknown tool", name: "does-not-exist", arguments: {} },
  { label: "schema-invalid args", name: "echo", arguments: { text: 123 } },
  { label: "tool throws internally", name: "boom", arguments: {} },
  { label: "tool returns isError", name: "errresult", arguments: {} },
]) {
  try {
    const r = await client.callTool({ name: call.name, arguments: call.arguments });
    console.log(`${call.label}: NO THROW ->`, JSON.stringify(r));
  } catch (e) {
    console.log(`${call.label}: THREW ->`, e.constructor.name, String(e.message).slice(0, 100));
  }
}

// Protocol-level failure is the class that rejects.
try {
  await client.request({ method: "tools/bogus", params: {} }, z.any());
} catch (e) {
  console.log("protocol-level (tools/bogus): THREW ->", e.constructor.name, String(e.message).slice(0, 100));
}

await client.close();
http.close();
