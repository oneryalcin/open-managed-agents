// Probe 49 — @modelcontextprotocol/sdk@1.29.0 bearer-header seam for
// plan 0122 M2.
//
// Run:
//   node scratch/49-mcp-auth-sdk-probe.mjs
//
// Questions:
// 1. Does StreamableHTTPClientTransport requestInit.headers reach both the
//    POST request path and the GET/SSE request path?
// 2. What rejection class/surface does the SDK expose for credentialed
//    401/403 connection failures?
//
// This is hermetic: local HTTP servers only, no external network and no API key.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "node:http";
import { z } from "zod";

const EXPECTED_AUTH = "Bearer probe-static-token";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}/mcp`);
    });
  });
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function probeSuccessfulHeaders() {
  const seen = [];
  const mcp = new McpServer({ name: "probe49-server", version: "0.0.1" });
  mcp.registerTool(
    "echo",
    { description: "Echoes text", inputSchema: { text: z.string() } },
    async ({ text }) => ({
      content: [{ type: "text", text }],
    }),
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => "probe49-session",
  });
  await mcp.connect(transport);

  const http = createServer(async (req, res) => {
    seen.push({
      method: req.method,
      authorization: req.headers.authorization,
      accept: req.headers.accept,
      session: req.headers["mcp-session-id"],
    });

    let body;
    if (req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = JSON.parse(Buffer.concat(chunks).toString() || "null");
    }
    await transport.handleRequest(req, res, body);
  });

  const url = await listen(http);
  const client = new Client({ name: "probe49-client", version: "0.0.1" });
  const clientTransport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: EXPECTED_AUTH } },
  });
  await client.connect(clientTransport);
  await client.listTools();
  await client.callTool({ name: "echo", arguments: { text: "ok" } });
  await client.close();
  await close(http);

  const postRequests = seen.filter((r) => r.method === "POST");
  const getRequests = seen.filter((r) => r.method === "GET");
  assert(postRequests.length > 0, "expected at least one POST request");
  assert(getRequests.length > 0, "expected at least one GET/SSE request");
  assert(
    postRequests.every((r) => r.authorization === EXPECTED_AUTH),
    `POST authorization mismatch: ${JSON.stringify(postRequests)}`,
  );
  assert(
    getRequests.every((r) => r.authorization === EXPECTED_AUTH),
    `GET authorization mismatch: ${JSON.stringify(getRequests)}`,
  );

  return {
    post_count: postRequests.length,
    get_count: getRequests.length,
    post_authorization: "present",
    get_authorization: "present",
    request_methods: seen.map((r) => r.method),
  };
}

async function probeStatusRejection(status) {
  const seen = [];
  const http = createServer(async (req, res) => {
    seen.push({
      method: req.method,
      authorization: req.headers.authorization,
      accept: req.headers.accept,
    });
    if (req.method === "GET") {
      // GET/SSE support is optional; returning 405 lets connect continue to
      // the POST initialize path where the status surface is captured.
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("SSE not supported");
      return;
    }
    for await (const _ of req) {
      // drain body
    }
    res.writeHead(status, {
      "content-type": "text/plain",
      "www-authenticate": 'Bearer realm="probe49"',
    });
    res.end(`probe ${status}`);
  });

  const url = await listen(http);
  const client = new Client({ name: `probe49-${status}`, version: "0.0.1" });
  const clientTransport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: EXPECTED_AUTH } },
  });

  let captured;
  try {
    await client.connect(clientTransport);
    throw new Error(`connect unexpectedly succeeded for ${status}`);
  } catch (error) {
    captured = {
      constructor: error?.constructor?.name,
      name: error?.name,
      message: String(error?.message ?? error).slice(0, 200),
      code: error?.code,
    };
  } finally {
    await client.close().catch(() => undefined);
    await close(http);
  }

  assert(captured.code === status, `${status} did not surface as code: ${JSON.stringify(captured)}`);
  assert(
    seen.some((r) => r.method === "POST" && r.authorization === EXPECTED_AUTH),
    `${status} POST did not carry authorization: ${JSON.stringify(seen)}`,
  );

  return {
    status,
    error: captured,
    request_methods: seen.map((r) => r.method),
    post_authorization: "present",
  };
}

const result = {
  sdk_version: "1.29.0",
  successful_headers: await probeSuccessfulHeaders(),
  rejection_401: await probeStatusRejection(401),
  rejection_403: await probeStatusRejection(403),
  conclusions: [
    "requestInit.headers.authorization reaches POST requests",
    "requestInit.headers.authorization reaches GET/SSE requests",
    "401/403 connection failures reject as StreamableHTTPError with .code",
  ],
};

console.log(JSON.stringify(result, null, 2));
