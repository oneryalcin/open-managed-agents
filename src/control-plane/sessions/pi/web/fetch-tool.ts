import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchWebResource, type WebFetchOptions, type WebFetchResult } from "../../../egress/guarded-fetch.ts";
import type { EgressPolicy } from "../../../egress/policy.ts";
import { validateWebUrl } from "../../../egress/web-url.ts";
import { convertWebDocument } from "./convert.ts";
import { absolutizeMarkdownLinks, matchShownUrl, shownUrls, type ProvenanceEvent } from "./provenance.ts";

// Plan 0149 slice 1d: web_fetch, run by the control plane. In hosted's order
// (probe 72): an environment with no web hosts refuses outright; a URL the
// session never showed is refused (url_not_in_prior_context); a near-match
// fetches the shown URL with hosted's note; then the validated, guarded fetch
// (every redirect hop re-checked) and conversion in an isolated worker.
// Errors are thrown so Pi marks the tool result is_error.

export interface WebToolContext {
  /** The session environment's egress policy; undefined = no web hosts. */
  policy: EgressPolicy | undefined;
  /** The session's events, for the prior-context rule. */
  events: readonly ProvenanceEvent[];
}

export interface WebFetchToolOptions {
  context: () => Promise<WebToolContext>;
  now?: () => Date;
  /** The guarded fetch (egress/guarded-fetch.ts); replaceable in tests. */
  fetchResource?: (url: string, options: WebFetchOptions) => Promise<WebFetchResult>;
}

/** Event content beyond what Pi carries; the translator publishes it. */
export interface WebToolResultDetails {
  /** Blocks, or a string (web_search's results are a JSON string, as hosted). */
  omaToolResultContent: unknown[] | string;
}

const USER_AGENT = "OpenManagedAgents-WebFetch/1.0";

export function createWebFetchTool(opts: WebFetchToolOptions): ToolDefinition<any, any, any> {
  return defineTool({
    name: "web_fetch",
    label: "web_fetch",
    description:
      "Fetch a web page and return its text. Only URLs shown earlier in this conversation (in a " +
      "user message, a web_search result, or a page fetched earlier) can be fetched, and only on " +
      "hosts the session's environment allows.",
    parameters: Type.Object(
      { url: Type.String({ description: "The URL to fetch, exactly as it was shown" }) },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, input: { url: string }, signal) => runWebFetch(input.url, opts, signal),
  });
}

async function runWebFetch(
  requested: string,
  opts: WebFetchToolOptions,
  signal: AbortSignal | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: WebToolResultDetails }> {
  const context = await opts.context();
  if (context.policy === undefined) {
    throw new Error(
      "Web fetch error: url_not_allowed — this session's environment allows no web hosts, so no URL " +
        "can be fetched. Do not retry; tell the user that web_fetch needs hosts in the environment's allowed_hosts.",
    );
  }
  const match = matchShownUrl(requested, shownUrls(context.events, opts.now?.() ?? new Date()));
  if (match === undefined) {
    throw new Error(
      "Web fetch error: url_not_in_prior_context — this URL was not fetched because it is not among the " +
        "URLs this conversation has shown you. A URL counts as shown when it appeared in a message from the " +
        "user, in a web_search result, or in the text of a page fetched earlier (its links count too for a " +
        "while; if one is refused, fetch that page again).",
    );
  }
  const policy = context.policy;
  const fetched = await (opts.fetchResource ?? fetchWebResource)(match.url, {
    validate: (raw) => validateWebUrl(raw, policy),
    headers: { "user-agent": USER_AGENT, accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.1" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!fetched.ok) throw new Error(`Web fetch error: ${fetched.code} — ${fetched.reason} (${fetched.url})`);
  if (fetched.status >= 400) {
    throw new Error(`Web fetch error: http_${fetched.status} — the server answered ${fetched.status} for ${fetched.finalUrl}`);
  }
  const converted = await convertWebDocument(fetched.body, fetched.contentType, signal === undefined ? {} : { signal });
  if (!converted.ok) throw new Error(`Web fetch error: ${converted.code} — ${converted.reason}`);

  // Relative links become absolute against the URL actually fetched (after
  // redirects), so the model and the prior-context rule read the same URLs.
  const linked = absolutizeMarkdownLinks(converted.text, fetched.finalUrl);
  const text = converted.truncated || fetched.truncated ? `${linked}\n\n[Content truncated.]` : linked;
  const document = {
    type: "document",
    title: converted.title,
    context: null,
    source: { type: "text", media_type: "text/plain", data: text },
  };
  const note = match.kind === "near"
    ? `Note: fetched ${match.url}, not the URL you gave. Only a URL that was shown earlier in this ` +
      "conversation can be fetched, and this is the shown URL that matches yours. If it differs from yours " +
      "by more than http or https, www. or a trailing slash, the content below is that page's, not the page " +
      "you asked for."
    : undefined;
  return {
    content: [{ type: "text", text: note === undefined ? text : `${note}\n\n${text}` }],
    details: {
      omaToolResultContent: note === undefined ? [document] : [{ type: "text", text: note }, document],
    },
  };
}
