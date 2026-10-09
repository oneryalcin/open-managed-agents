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

export function createTavilySearchProvider(opts: {
  apiKey: string;
  /** The SSRF-guarded fetch (redirects refused, so the key cannot be redirected). */
  fetch?: GuardedFetch;
}): WebSearchProvider {
  const fetch = opts.fetch ?? createGuardedFetch();
  const scrub = (text: string) => scrubKnownSecrets(text, [opts.apiKey]);
  return {
    async search(query, domains, signal) {
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
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        throw new Error(scrub(`search provider request failed: ${error instanceof Error ? error.message : String(error)}`));
      }
      const text = await response.text();
      if (!response.ok) {
        throw new Error(scrub(`search provider answered ${response.status}: ${text.slice(0, 300)}`));
      }
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
