// Plan 0149 slice 1c: hosted's prior-context rule (probe 72). web_fetch may
// only fetch a URL the session has shown, which is the main guard against a
// prompt-injected model exfiltrating data in a URL to an allowed host.
//
// Shown means it appeared in:
// - a user message (delivered or not: it is the user's intent);
// - a successful web_search result;
// - the text of a page fetched successfully in the last 30 minutes (links
//   resolved against that page's URL);
// - a custom tool result, which the client supplies.
// Not counted: MCP tool results (a third-party server could plant URLs) and
// error results. Tool results are stored already capped, so only text the
// model saw counts. Everything is read from persisted events and their times,
// so a rebuilt session gives the same answer.

export interface ProvenanceEvent {
  id: string;
  type: string;
  processed_at: string | null;
  payload: Record<string, unknown>;
}

/** Fetched-page links count for this long (hosted: "for a while"). */
export const PAGE_LINK_TTL_MS = 30 * 60_000;

export interface ShownUrls {
  exact: Set<string>;
  /** Near-match key to the shown URL it came from. */
  near: Map<string, string>;
}

export type ShownUrlMatch = { kind: "exact" | "near"; url: string };

export function shownUrls(events: readonly ProvenanceEvent[], now: Date): ShownUrls {
  const shown: ShownUrls = { exact: new Set(), near: new Map() };
  const add = (raw: string, base?: string) => {
    const url = canonicalUrl(raw, base);
    if (url === undefined) return;
    shown.exact.add(url);
    const key = nearKey(url);
    if (key !== undefined && !shown.near.has(key)) shown.near.set(key, url);
  };
  const toolUses = new Map<string, { name: unknown; input: Record<string, unknown> }>();
  for (const event of events) {
    const payload = event.payload;
    if (
      event.type === "user.message" ||
      (event.type === "user.custom_tool_result" && payload.is_error !== true)
    ) {
      for (const url of absoluteUrls(textOf(payload.content))) add(url);
    } else if (event.type === "agent.tool_use") {
      const input = isRecord(payload.input) ? payload.input : {};
      const use = { name: payload.name, input };
      // Results reference either the public event id (calls the control
      // plane publishes) or the payload's tool_use_id (Pi-translated calls).
      toolUses.set(event.id, use);
      if (typeof payload.tool_use_id === "string") toolUses.set(payload.tool_use_id, use);
    } else if (event.type === "agent.tool_result" && payload.is_error !== true) {
      const use = toolUses.get(String(payload.tool_use_id));
      if (use?.name === "web_search") {
        for (const url of absoluteUrls(textOf(payload.content))) add(url);
      } else if (use?.name === "web_fetch" && isFresh(event.processed_at, now)) {
        const base = typeof use.input.url === "string" ? use.input.url : undefined;
        const text = documentText(payload.content);
        for (const url of absoluteUrls(text)) add(url);
        if (base !== undefined) for (const href of markdownLinks(text)) add(href, base);
      }
    }
  }
  return shown;
}

export function matchShownUrl(requested: string, shown: ShownUrls): ShownUrlMatch | undefined {
  const url = canonicalUrl(requested);
  if (url === undefined) return undefined;
  if (shown.exact.has(url)) return { kind: "exact", url };
  const key = nearKey(url);
  const near = key === undefined ? undefined : shown.near.get(key);
  return near === undefined ? undefined : { kind: "near", url: near };
}

/** Lower-case scheme and host, default port and fragment dropped. */
function canonicalUrl(raw: string, base?: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.hostname.endsWith(".")) url.hostname = url.hostname.slice(0, -1);
  url.hash = "";
  return url.href;
}

/** Hosted's near-match: ignores http/https, a leading www. and a trailing slash. */
function nearKey(canonical: string): string | undefined {
  try {
    const url = new URL(canonical);
    const host = url.hostname.replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "");
    return `${host}${url.port ? `:${url.port}` : ""}${path}${url.search}`;
  } catch {
    return undefined;
  }
}

function isFresh(processedAt: string | null, now: Date): boolean {
  const at = processedAt === null ? Number.NaN : Date.parse(processedAt);
  return Number.isFinite(at) && now.getTime() - at <= PAGE_LINK_TTL_MS;
}

// The URL exactly as shown always counts. Prose convenience only: a variant
// without trailing sentence punctuation (. , ; :) also counts, as does one
// without an unbalanced closing ), ] or } ("(see https://x/y)"). Both come
// from text already in the context, not from the model; `!`, `?` and other
// characters that can be URL data are never trimmed, and ] } ) inside a URL
// do not end it.
function absoluteUrls(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    let url = match[0];
    urls.push(url);
    for (;;) {
      const next = trimOnce(url);
      if (next === url) break;
      url = next;
      urls.push(url);
    }
  }
  return urls;
}

const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function trimOnce(url: string): string {
  const trimmed = url.replace(/[.,;:]+$/, "");
  if (trimmed !== url) return trimmed;
  const last = url.at(-1);
  const opener = last === undefined ? undefined : CLOSERS[last];
  if (opener !== undefined && count(url, opener) < count(url, last!)) return url.slice(0, -1);
  return url;
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/**
 * Markdown link destinations, `](dest)`: backslash escapes decoded, balanced
 * parentheses kept, and only destinations with a real closing `)`.
 */
function markdownLinks(text: string): string[] {
  const links: string[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf("](", from);
    if (start < 0) return links;
    let depth = 0;
    let destination = "";
    let closed = false;
    let index = start + 2;
    for (; index < text.length; index += 1) {
      const char = text[index]!;
      if (char === "\\" && index + 1 < text.length) {
        destination += text[index + 1];
        index += 1;
        continue;
      }
      if (/\s/.test(char)) break;
      if (char === "(") depth += 1;
      else if (char === ")") {
        if (depth === 0) {
          closed = true;
          break;
        }
        depth -= 1;
      }
      destination += char;
    }
    if (closed && destination !== "") links.push(destination);
    from = index;
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

function documentText(content: unknown): string {
  if (!Array.isArray(content)) return textOf(content);
  return content
    .map((block) => {
      if (!isRecord(block)) return "";
      if (isRecord(block.source) && typeof block.source.data === "string") return block.source.data;
      return typeof block.text === "string" ? block.text : "";
    })
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
