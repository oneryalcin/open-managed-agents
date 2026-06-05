import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(new URL(".", import.meta.url).pathname);
const port = Number(process.env.OMA_CONSOLE_PORT ?? 4177);

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
});
