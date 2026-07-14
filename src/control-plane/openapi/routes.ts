import { createReadStream, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { Context, Env, Hono } from "hono";
import { createOpenApiDocument } from "./document.ts";

export const OPENAPI_DOCUMENT_PATH = "/openapi.json";
export const OPENAPI_DOCS_MOUNT = "/docs";

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
]);

const DOCS_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export interface OpenApiRoutesConfig {
  /** Absolute path of the vendored documentation UI tree. */
  root: string;
}

export function registerOpenApiRoutes<E extends Env>(
  app: Hono<E>,
  config: OpenApiRoutesConfig,
): void {
  const realRoot = realpathSync(resolve(config.root));
  const serialized = JSON.stringify(createOpenApiDocument(), null, 2) + "\n";

  app.get(OPENAPI_DOCUMENT_PATH, (c) => {
    setDocsHeaders(c);
    c.header("content-type", "application/json; charset=utf-8");
    return c.body(serialized);
  });

  app.get(OPENAPI_DOCS_MOUNT, (c) => c.redirect(`${OPENAPI_DOCS_MOUNT}/`, 301));
  app.get(`${OPENAPI_DOCS_MOUNT}/*`, (c) => {
    const raw = c.req.path.slice(OPENAPI_DOCS_MOUNT.length + 1);
    const relative = raw === "" ? "index.html" : decodeOrNull(raw);
    if (relative === null || relative.includes("\0")) return notFound(c);

    const candidate = resolve(realRoot, relative);
    if (!contains(realRoot, candidate)) return notFound(c);

    let file: string;
    try {
      file = realpathSync(candidate);
    } catch {
      return notFound(c);
    }
    if (!contains(realRoot, file) || !statSync(file).isFile()) return notFound(c);

    const contentType = CONTENT_TYPES.get(extname(file));
    if (contentType === undefined) return notFound(c);

    setDocsHeaders(c);
    c.header("content-type", contentType);
    return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
  });
}

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function decodeOrNull(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function notFound(c: Context): Response {
  setDocsHeaders(c);
  return c.text("Not found\n", 404);
}

function setDocsHeaders(c: Context): void {
  c.header("cache-control", "no-store");
  c.header("content-security-policy", DOCS_CSP);
  c.header("referrer-policy", "no-referrer");
  c.header("x-content-type-options", "nosniff");
  c.header("x-frame-options", "DENY");
}
