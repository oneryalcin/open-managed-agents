import { createServer } from "node:http";

const MAX_REQUEST_BYTES = 1024 * 1024;

export async function startAlphaOpenAICompatibleFixture(options) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        sendJson(res, 404, { error: { message: "not found" } });
        return;
      }
      const body = JSON.parse(await readBody(req));
      const authorization = req.headers.authorization;
      requests.push({ body, authorization });
      if (authorization !== `Bearer ${options.apiKey}`) {
        sendJson(res, 401, { error: { message: "fixture rejected authorization" } });
        return;
      }
      if (body.model !== options.modelId || body.stream !== true) {
        sendJson(res, 400, { error: { message: "fixture received unexpected model request" } });
        return;
      }

      const messages = Array.isArray(body.messages) ? body.messages : [];
      const hasToolResult = messages.some((message) => message?.role === "tool");
      if (!hasToolResult) {
        const bash = Array.isArray(body.tools)
          && body.tools.some((tool) => tool?.type === "function" && tool.function?.name === "bash");
        if (!bash) {
          sendJson(res, 400, { error: { message: "fixture expected the bash tool" } });
          return;
        }
        sendSse(res, [
          chunk(options.modelId, {
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: "call_oma_alpha_smoke",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command: `printf ${options.token}` }),
              },
            }],
          }),
          chunk(options.modelId, {}, "tool_calls", usage()),
        ]);
        return;
      }

      if (!JSON.stringify(messages).includes(options.token)) {
        sendJson(res, 400, { error: { message: "fixture did not receive the expected tool result" } });
        return;
      }
      sendSse(res, [
        chunk(options.modelId, { role: "assistant", content: options.token }),
        chunk(options.modelId, {}, "stop", usage()),
      ]);
    } catch (error) {
      sendJson(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not resolve fixture address");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    assertComplete() {
      if (requests.length !== 2) {
        throw new Error(`Compatible-provider fixture expected 2 model requests, observed ${requests.length}`);
      }
      if (!requests[1]?.body?.messages?.some((message) => message?.role === "tool")) {
        throw new Error("Compatible-provider fixture did not observe the sandbox tool result round trip");
      }
    },
    requestSummary() {
      return requests.map(({ body }) => ({ model: body.model, stream: body.stream }));
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function chunk(model, delta, finishReason = null, chunkUsage) {
  return {
    id: "chatcmpl-oma-alpha",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(chunkUsage === undefined ? {} : { usage: chunkUsage }),
  };
}

function usage() {
  return { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
}

function sendSse(res, chunks) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const value of chunks) res.write(`data: ${JSON.stringify(value)}\n\n`);
  res.end("data: [DONE]\n\n");
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("fixture request exceeded 1 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
