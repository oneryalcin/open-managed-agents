/**
 * Static serving for the bundled operator console (plan 0120 §3.1).
 *
 * Hand-written rather than @hono/node-server's serveStatic because the
 * console needs two things that helper cannot express: `.jsx` served as
 * text/babel (hono's mime table has no jsx entry) and `cache-control:
 * no-store` on every asset (its options have no header hook). The handler
 * serves exactly one directory tree and nothing else — the traversal guard
 * below is the one security-load-bearing piece.
 *
 * Guard shape (0120 review, Codex-adversarial finding): a bare
 * `candidate.startsWith(root)` accepts prefix-sharing *siblings* such as
 * `<root>-private/…`, so containment is checked against `root + sep`, and
 * against the realpath so a symlink inside the tree cannot point out of it.
 */
import { createReadStream, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { Context, Env, Hono } from "hono";

export const CONSOLE_MOUNT = "/console";

// Everything the console ships today. Unknown extensions 404 rather than
// falling back to octet-stream: the tree is ours, so an unlisted type is a
// packaging mistake we want loud, not a download prompt.
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".jsx", "text/babel; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
]);

// unsafe-eval is the price of in-browser Babel; unsafe-inline (script) is the
// price of Babel executing transformed <script type="text/babel"> blocks.
// connect-src 'self' blocks fetch/XHR/WebSocket exfiltration of the keys in
// page memory; base-uri and form-action close the <base>-hijack and form-post
// channels. Top-level navigation remains uncoverable by CSP — this is
// defense-in-depth behind React's escaping, not a substitute for it.
const CONSOLE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export interface ConsoleStaticConfig {
  /** Absolute path of the console directory (contains index.html). */
  root: string;
}

export function registerConsoleRoutes<E extends Env>(
  app: Hono<E>,
  config: ConsoleStaticConfig,
): void {
  const root = resolve(config.root);
  // Resolved once: symlink containment is checked against where the tree
  // *really* lives, so a console dir that is itself a symlink still works.
  const realRoot = realpathSync(root);

  // The console's asset URLs are relative (src/api.js …); served at the bare
  // mount they would resolve to /src/… and 404. Redirect instead of serving
  // index.html so the browser's base URL is always the trailing-slash form.
  app.get(CONSOLE_MOUNT, (c) => c.redirect(`${CONSOLE_MOUNT}/`, 301));

  app.get(`${CONSOLE_MOUNT}/*`, (c) => {
    const raw = c.req.path.slice(CONSOLE_MOUNT.length + 1);
    const relative = raw === "" ? "index.html" : decodeOrNull(raw);
    if (relative === null || relative.includes("\0")) return notFound(c);

    const candidate = resolve(realRoot, relative);
    if (!contains(realRoot, candidate)) return notFound(c);

    let file: string;
    try {
      file = realpathSync(candidate); // also the existence check
    } catch {
      return notFound(c);
    }
    if (!contains(realRoot, file) || !statSync(file).isFile()) {
      return notFound(c);
    }

    const contentType = CONTENT_TYPES.get(extname(file));
    if (contentType === undefined) return notFound(c);

    setConsoleHeaders(c);
    c.header("content-type", contentType);
    return c.body(createReadableFileStream(file));
  });
}

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

// Hono half-decodes (%2e -> "." but %2f stays); one more decode maps the
// remaining escapes to their filesystem form so ..%2f is seen as ../ by the
// containment check instead of sneaking past it as an opaque segment.
function decodeOrNull(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function notFound(c: Context): Response {
  setConsoleHeaders(c);
  return c.text("Not found\n", 404);
}

function setConsoleHeaders(c: Context): void {
  c.header("cache-control", "no-store");
  c.header("content-security-policy", CONSOLE_CSP);
  c.header("x-frame-options", "DENY");
}

function createReadableFileStream(path: string): ReadableStream {
  // Node's fs streams convert cleanly; Response accepts web ReadableStream.
  // Files here are ≤3 MB (babel.min.js), so streaming keeps memory flat
  // without any range/caching complexity the console does not need.
  return Readable.toWeb(createReadStream(path)) as ReadableStream;
}
