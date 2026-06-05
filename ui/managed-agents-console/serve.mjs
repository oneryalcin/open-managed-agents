import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(new URL(".", import.meta.url).pathname);
const port = Number(process.env.OMA_CONSOLE_PORT ?? 4177);
const apiBase = process.env.OMA_CONSOLE_API_BASE ?? "http://127.0.0.1:40178";
const betaHeader = [
  "managed-agents-2026-04-01",
  "files-api-2025-04-14",
].join(", ");
const strippedProxyResponseHeaders = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".jsx", "text/babel; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
]);

function resolvePath(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0] ?? "/"));
  const relative = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  const candidate = resolve(join(root, relative));
  if (!candidate.startsWith(root)) return null;
  if (!existsSync(candidate)) return null;
  const stat = statSync(candidate);
  if (stat.isDirectory()) return join(candidate, "index.html");
  return candidate;
}

const server = createServer((req, res) => {
  if ((req.url ?? "").startsWith("/v1/")) {
    proxyApiRequest(req, res);
    return;
  }

  const filePath = resolvePath(req.url ?? "/");
  if (!filePath) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found\n");
    return;
  }

  const contentType =
    contentTypes.get(extname(filePath)) ?? "application/octet-stream";
  res.writeHead(200, {
    "cache-control": "no-store",
    "content-type": contentType,
  });
  createReadStream(filePath).pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Managed Agents Console: http://127.0.0.1:${port}/`);
  console.log(`OMA API proxy: ${apiBase}`);
});

async function proxyApiRequest(req, res) {
  const target = new URL(req.url ?? "/", apiBase);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  headers.set("anthropic-beta", headers.get("anthropic-beta") ?? betaHeader);
  headers.delete("host");

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
      duplex: "half",
    });
    const responseHeaders = {};
    upstream.headers.forEach((value, key) => {
      if (strippedProxyResponseHeaders.has(key.toLowerCase())) return;
      responseHeaders[key] = value;
    });
    res.writeHead(upstream.status, responseHeaders);
    if (upstream.body) {
      const reader = upstream.body.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        res.write(Buffer.from(next.value));
      }
    }
    res.end();
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      type: "error",
      error: {
        type: "api_error",
        message: `Could not reach OMA API at ${apiBase}`,
      },
      request_id: "req_console_proxy",
      detail: String(error),
    }));
  }
}
