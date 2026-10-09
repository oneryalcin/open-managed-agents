import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

// Plan 0149 slice 1b: fetched bytes to the text a web tool returns.
//
// HTML goes through turndown in a worker for isolation, not just fairness:
// ordinary pages convert in 15-230 ms, but link-dense or deeply nested HTML
// can take seconds and hundreds of MB, and a nesting bomb runs until the stack
// overflows. Each conversion gets its own short-lived worker with a heap cap,
// a hard deadline (terminate), and caller abort; at most MAX_WORKERS run at
// once. The worker is inline (`eval`) and loads turndown by absolute path, so
// it runs the same under vitest, the container's node, and the packaged CLI.

export interface ConvertOptions {
  /** Cap on the returned text (characters). */
  maxChars?: number;
  /** Hard deadline for HTML conversion. */
  deadlineMs?: number;
  signal?: AbortSignal;
}

export type ConvertResult =
  | { ok: true; text: string; title: string | null; truncated: boolean }
  | {
      ok: false;
      code: "unsupported_media" | "conversion_failed" | "timeout" | "aborted";
      reason: string;
    };

const DEFAULT_MAX_CHARS = 100_000;
const DEFAULT_DEADLINE_MS = 5_000;
const MAX_WORKERS = 2;
const WORKER_HEAP_MB = 256;

export async function convertWebDocument(
  body: Uint8Array,
  contentType: string | null,
  opts: ConvertOptions = {},
): Promise<ConvertResult> {
  const mediaType = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const html = mediaType === "text/html" || mediaType === "application/xhtml+xml";
  const textual = mediaType.startsWith("text/") || mediaType === "application/json" ||
    mediaType.endsWith("+json") || mediaType === "application/xml" || mediaType.endsWith("+xml");
  if (!html && !textual) {
    return { ok: false, code: "unsupported_media", reason: `cannot read ${mediaType || "unknown"} content as text` };
  }
  const decoded = decode(body, charsetOf(contentType) ?? (html ? sniffMetaCharset(body) : undefined));
  if (!html) return capped(decoded, null, opts.maxChars);
  const converted = await convertHtml(decoded, opts);
  return converted.ok ? capped(converted.text, titleOf(decoded), opts.maxChars) : converted;
}

function capped(text: string, title: string | null, maxChars = DEFAULT_MAX_CHARS): ConvertResult {
  return text.length > maxChars
    ? { ok: true, text: text.slice(0, maxChars), title, truncated: true }
    : { ok: true, text, title, truncated: false };
}

function charsetOf(contentType: string | null): string | undefined {
  return /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType ?? "")?.[1];
}

function sniffMetaCharset(body: Uint8Array): string | undefined {
  const head = new TextDecoder("latin1").decode(body.subarray(0, 1024));
  return /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
}

function decode(body: Uint8Array, charset: string | undefined): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body); // unknown label
  }
}

function titleOf(html: string): string | null {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  if (!raw) return null;
  return raw
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

// --- the worker --------------------------------------------------------------

// A file URL: the worker loads it with import(), which works whether Node
// runs the inline source as CommonJS (vitest) or as an ES module (plain node
// in a "type": "module" package, where require does not exist).
const turndownUrl = pathToFileURL(createRequire(import.meta.url).resolve("turndown")).href;

const WORKER_SOURCE = `
Promise.all([import("node:worker_threads"), import(${JSON.stringify(turndownUrl)}).then((m) => m.default ?? m)])
  .then(([{ parentPort }, TurndownService]) => {
    parentPort.once("message", (html) => {
      try {
        const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
        td.remove(["head", "title", "script", "style", "noscript", "iframe", "svg", "nav", "header", "footer", "form"]);
        parentPort.postMessage({ ok: true, text: td.turndown(html) });
      } catch (error) {
        parentPort.postMessage({ ok: false, reason: String((error && error.message) || error) });
      }
    });
    parentPort.postMessage({ ready: true });
  });
`;

let running = 0;
const waiting: Array<() => void> = [];

async function convertHtml(
  html: string,
  opts: ConvertOptions,
): Promise<{ ok: true; text: string } | Extract<ConvertResult, { ok: false }>> {
  if (opts.signal?.aborted) return aborted();
  if (running >= MAX_WORKERS) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await runWorker(html, opts);
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function runWorker(
  html: string,
  opts: ConvertOptions,
): Promise<{ ok: true; text: string } | Extract<ConvertResult, { ok: false }>> {
  if (opts.signal?.aborted) return Promise.resolve(aborted());
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    });
    let settled = false;
    const finish = (result: Parameters<typeof resolve>[0]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, code: "timeout", reason: "the page took too long to convert" }),
      opts.deadlineMs ?? DEFAULT_DEADLINE_MS,
    );
    const onAbort = () => finish(aborted());
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (message: { ready?: boolean; ok?: boolean; text?: string; reason?: string }) => {
      // The worker loads turndown asynchronously; send the page once it can listen.
      if (message.ready) {
        worker.postMessage(html);
        return;
      }
      finish(message.ok
        ? { ok: true, text: (message.text ?? "").trim() }
        : { ok: false, code: "conversion_failed", reason: message.reason ?? "conversion failed" });
    });
    // Heap limit, stack overflow outside the try, or a crash.
    worker.once("error", (error: unknown) =>
      finish({
        ok: false,
        code: "conversion_failed",
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    worker.once("exit", () =>
      finish({ ok: false, code: "conversion_failed", reason: "the converter stopped unexpectedly" }),
    );
  });
}

function aborted(): Extract<ConvertResult, { ok: false }> {
  return { ok: false, code: "aborted", reason: "the request was cancelled" };
}
