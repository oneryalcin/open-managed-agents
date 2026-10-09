import { readFileSync } from "node:fs";
import { createGuardedFetch, type GuardedFetch } from "../../../egress/guarded-fetch.ts";
import { scrubKnownSecrets } from "../../../logging.ts";

// Plan 0149 slice 2: where web_search results come from. The provider is a
// fixed, operator-configured trust grant, separate from the session's
// allowed_hosts (which limit results, not who receives the query). Every
// string the provider controls is scrubbed of its API key before it can reach
// events, logs or the model.

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

export interface WebSearchProvider {
  /** Results only from `domains` (the caller re-checks them anyway). */
  search(query: string, domains: readonly string[], signal?: AbortSignal): Promise<WebSearchResult[]>;
}

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const MAX_RESULTS = 5;

const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;

export function createTavilySearchProvider(opts: {
  apiKey: string;
  /** The SSRF-guarded fetch (redirects refused, so the key cannot be redirected). */
  fetch?: GuardedFetch;
  maxResponseBytes?: number;
  /** Covers the whole exchange, body included. */
  timeoutMs?: number;
}): WebSearchProvider {
  const fetch = opts.fetch ?? createGuardedFetch();
  const scrub = (text: string) => scrubKnownSecrets(text, [opts.apiKey]);
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  return {
    async search(query, domains, callerSignal) {
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const signal = callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout]);
      const fail = (message: string): never => {
        if (timeout.aborted) throw new Error("search provider timed out");
        // Scrub the whole text before cutting it: a key across the cut would
        // otherwise leave its prefix behind.
        throw new Error(scrub(message).slice(0, 400));
      };
      let response: Response;
      try {
        response = await fetch(TAVILY_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({
            query,
            search_depth: "basic",
            max_results: MAX_RESULTS,
            include_domains: domains,
            include_domains_mode: "restrict",
          }),
          signal,
        });
      } catch (error) {
        return fail(`search provider request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      let text: string;
      try {
        text = await readCapped(response, maxBytes);
      } catch (error) {
        return fail(`search provider response failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!response.ok) return fail(`search provider answered ${response.status}: ${text}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("search provider returned a malformed response");
      }
      const results = isRecord(parsed) && Array.isArray(parsed.results) ? parsed.results : [];
      return results.flatMap((item) => {
        if (!isRecord(item) || typeof item.url !== "string") return [];
        return [{
          title: scrub(typeof item.title === "string" ? item.title : item.url),
          url: scrub(item.url),
          content: scrub(typeof item.content === "string" ? item.content : ""),
        }];
      });
    },
  };
}

/** The body as text, refusing more than `maxBytes` while streaming. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`response too large (over ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The deployment's search provider, from OMA_WEB_SEARCH_PROVIDER (`tavily`)
 * and OMA_WEB_SEARCH_API_KEY or OMA_WEB_SEARCH_API_KEY_FILE. Unset = no
 * web_search. A provider without a key, or an unknown one, fails startup
 * rather than silently disabling search.
 */
export interface WebSearchEnv {
  OMA_WEB_SEARCH_PROVIDER?: string;
  OMA_WEB_SEARCH_API_KEY?: string;
  OMA_WEB_SEARCH_API_KEY_FILE?: string;
}

export function webSearchProviderFromEnv(
  env: WebSearchEnv,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): WebSearchProvider | undefined {
  const name = env.OMA_WEB_SEARCH_PROVIDER?.trim();
  if (name === undefined || name === "") return undefined;
  if (name !== "tavily") {
    throw new Error(`OMA_WEB_SEARCH_PROVIDER must be "tavily" (got ${JSON.stringify(name)})`);
  }
  const file = env.OMA_WEB_SEARCH_API_KEY_FILE?.trim();
  const apiKey = (file ? readFile(file) : env.OMA_WEB_SEARCH_API_KEY ?? "").trim();
  if (apiKey === "") {
    throw new Error("OMA_WEB_SEARCH_PROVIDER=tavily needs OMA_WEB_SEARCH_API_KEY or OMA_WEB_SEARCH_API_KEY_FILE");
  }
  return createTavilySearchProvider({ apiKey });
}
