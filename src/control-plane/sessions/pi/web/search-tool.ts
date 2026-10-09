import { isIP } from "node:net";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { EgressPolicy } from "../../../egress/policy.ts";
import { validateWebUrl } from "../../../egress/web-url.ts";
import type { WebToolContext, WebToolResultDetails } from "./fetch-tool.ts";
import type { WebSearchProvider } from "./search-provider.ts";

// Plan 0149 slice 2: web_search. No query leaves when the environment allows
// no searchable host (hosted's url_not_allowed); the provider is restricted to
// the allowed hosts, and every result is re-checked against the full policy
// before the model sees it. The result is hosted's: a JSON string of
// search_result blocks.

export function createWebSearchTool(opts: {
  context: () => Promise<WebToolContext>;
  provider: WebSearchProvider;
}): ToolDefinition<any, any, any> {
  return defineTool({
    name: "web_search",
    label: "web_search",
    description:
      "Search the web. Results come only from hosts the session's environment allows; their URLs " +
      "can then be read with web_fetch.",
    parameters: Type.Object(
      { query: Type.String({ description: "What to search for" }) },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, input: { query: string }, signal) => runWebSearch(input.query, opts, signal),
  });
}

async function runWebSearch(
  query: string,
  opts: { context: () => Promise<WebToolContext>; provider: WebSearchProvider },
  signal: AbortSignal | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: WebToolResultDetails }> {
  const { policy } = await opts.context();
  const domains = policy === undefined ? [] : searchDomains(policy);
  if (policy === undefined || domains.length === 0) {
    throw new Error(
      "Web search error: url_not_allowed — no host in this session's environment (its allowed_hosts) can " +
        "be searched: the list is empty or holds only local, private or internal names. Do not retry; tell " +
        "the user that web_search needs public host names in the environment's allowed_hosts.",
    );
  }
  const results = await opts.provider.search(query, domains, signal);
  const blocks = results
    .filter((result) => validateWebUrl(result.url, policy).ok)
    .map((result) => ({
      type: "search_result",
      source: result.url,
      title: result.title,
      content: [{ type: "text", text: result.content }],
      citations: { enabled: true },
    }));
  const json = JSON.stringify(blocks);
  return { content: [{ type: "text", text: json }], details: { omaToolResultContent: json } };
}

const LOCAL_SUFFIXES = [".local", ".localhost", ".internal", ".invalid", ".lan", ".home.arpa"];

/** The policy's hosts as search domains: `*.x` as `x`, public names only. */
export function searchDomains(policy: EgressPolicy): string[] {
  const domains: string[] = [];
  for (const entry of policy.allow) {
    const host = entry.host.startsWith("*.") ? entry.host.slice(2) : entry.host;
    const local = host === "localhost" || !host.includes(".") || isIP(host) !== 0 ||
      LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
    if (!local && !domains.includes(host)) domains.push(host);
  }
  return domains;
}
