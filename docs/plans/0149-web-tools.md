# 0149 — Web tools (`web_fetch`, `web_search`)

## Status

Proposed 2026-10-09. An M2 item in [0145](0145-road-to-external-testers.md)
(PARITY pre-v1 arc 3). Decisions D1–D3 made by the maintainer on 2026-10-09:
D1 (a), D2 (b), D3 (b). The first search provider (below) is a proposal for
review.

## Problem

Agents cannot read the web. OMA accepts the CMA builtin names `web_fetch` and
`web_search` but materializes them as deployment-disabled (plan 0128), so an
agent asked to look something up has no tool. "A realistic coding task end to
end" (the M2 goal) usually needs docs lookup.

## What hosted does (probe 72, 2026-10-09)

[`scratch/72-managed-agents-web-tools-probe.md`](../../scratch/72-managed-agents-web-tools-probe.md),
`claude-sonnet-5`:

- **Events:** both are ordinary builtin tools. Each call is an `agent.tool_use`
  (`web_fetch` with `{url}`, `web_search` with `{query}`) followed by an
  `agent.tool_result`.
- **Permissions:** policies apply. `always_ask` pauses with `requires_action`.
- **Hosts:** both are scoped by the environment's `allowed_hosts`. With none,
  each returns an `is_error` result, `url_not_allowed`, telling the model not
  to retry.
- **`web_fetch` result:** one `document` block: the page as text/plain (a
  small front-matter header, then the readable text) plus its `title`.
- **`web_search` result:** a JSON string of search result blocks with
  citations, only from allowed hosts.
- **Usage:** a search counts `server_tool_use.web_search_requests`; a fetch
  counts nothing. So search looks like Anthropic's server web search with
  `allowed_domains` set to the allowed hosts, and fetch like the harness's own
  request.

## What OMA has

- **SSRF guard:** `createGuardedMcpFetch` (`sessions/pi/mcp/fetch.ts`) pins
  DNS through the egress lookup, blocks private and metadata ranges and IP
  literals, and refuses redirects. MCP has used it in production since plan
  0122.
- **Host matching:** `hostMatchesAllowPattern` and the canonical
  `allowed_hosts` live in `egress/policy.ts`.
- **Plumbing:** custom-tool and MCP execution run in the control plane, so the
  tool plumbing and the permission state machine already exist.
- **No server tools in Pi:** the pinned Pi 0.85.1 has no Anthropic
  server-tool support, so passing `web_search` through to the model request
  is out until the Pi 1.x upgrade (#249) at the earliest.

## Decisions (2026-10-09)

- **D1 — who executes `web_fetch`.**
  - **(a) The control plane (recommended).** It runs the guarded fetch, but
    only to hosts in the session environment's `allowed_hosts`. Text and
    HTML pages are converted to readable text, with caps on bytes and time,
    and the result is returned as hosted's `document` block. This works the
    same on every sandbox provider, including none, and adds no new egress
    path: the guard and the allowlist are the existing ones.
  - **(b) The sandbox, via the egress sidecar.** That is docker-local only,
    and needs a fetch-and-convert tool inside the sandbox image.
- **D2 — `web_search` backend.**
  - **(a) Anthropic server web search, in a side request (recommended).** A
    small Messages API call with the `web_search` server tool and
    `allowed_domains` set to the allowed hosts, using the deployment's
    Anthropic credential. Results and counting match hosted, and it is
    priced per search (Anthropic's list price), so it adds to `list_cost`.
    Search is unavailable, with an honest error result, when no Anthropic
    credential is configured.
  - **(b) A pluggable search provider** (Brave, Tavily, …): new configuration
    and new dependencies.
  - **(c) Fetch only for now:** `web_search` stays disabled.
- **D3 — HTML to text.**
  - **(a) A small in-house converter (recommended).** Drop scripts, styles,
    nav and footer, keep headings, links and lists as plain text, collapse
    whitespace. Good enough for docs pages, and no dependency.
  - **(b) A vetted library** (for example `turndown` plus a DOM parser), which
    brings new transitive packages under ADR 0017's age rule.

## Chosen design

- **D1 (a): the control plane fetches.** The URL's host must match the
  environment's `allowed_hosts`; `unrestricted` networking allows any public
  host. Then the MCP SSRF-guarded fetch runs: pinned DNS, private, metadata
  and IP-literal targets refused, `https` only, redirects not followed. A
  redirect is reported to the model, which may fetch the target if it is
  allowed. Caps: 2 MB of body and 20 s.
- **D3 (b): `turndown` 7.2.4 converts HTML to text.** It adds two packages
  (itself plus its bundled DOM, `@mixmark-io/domino`), against 12–13 for
  `html-to-text` or `node-html-markdown`, and is past ADR 0017's age rule.
  - Measured: a 1.1 MB Node docs page converts in about 260 ms, synchronous,
    so conversion runs in a worker thread.
  - `<head>` is dropped (the title is taken separately), as are scripts,
    styles, nav, header, footer, forms and SVG.
  - The converted text is capped (for example 100k characters), with a note
    when it was cut.
  - JSON and plain text pass through; other media types are refused.
  - The result is hosted's `document` block: text/plain data and a `title`.
- **D2 (b): pluggable search providers.** A `WebSearchProvider` interface
  takes `(query, allowedDomains | "any")` and returns results (title, URL,
  snippet), each checked against the allowed hosts again on return.
  Providers call plain REST through the guarded fetch, so no SDKs. The
  operator configures one with `OMA_WEB_SEARCH_PROVIDER` plus its API key
  (in the SecretsStore when `OMA_MASTER_KEY` is set, otherwise the env var).
  With none configured, `web_search` stays deployment-disabled, as today.
  - **Proposed first provider: Tavily.** Its `include_domains` maps directly
    onto `allowed_hosts`, and it is built for agent use.
  - **Brave Search** would come second: its domains are scoped with `site:`
    in the query.
  - Results return as hosted's JSON string of result blocks.
    `server_tool_use.web_search_requests` counts OMA-executed searches;
    search costs are not priced (provider pricing varies), so `list_cost`
    stays model-only.
- **Tool surface:** both tools are control-plane tools registered with Pi
  beside custom and MCP tools. They are enabled per agent by the existing
  toolset config, and the permission policy runs through the existing
  confirmation flow. Events are `agent.tool_use` and `agent.tool_result`, as
  for other builtins.

## Slices

1. `web_fetch` (D1, D3): the host check, the guarded fetch, conversion, the
   result shape, permissions, and tests against a local HTTPS fixture.
2. `web_search` (D2): the provider interface, Tavily, domain scoping on
   request and result, usage counting, and a credential-gated live smoke.
3. Docs: PARITY.md, and the tester brief: web access follows the
   environment's allowlist.

## Tests that prevent real bugs

- A host outside `allowed_hosts` is refused before any connection is made.
- A redirect to a private address, or any redirect, is not followed.
- Private, metadata and IP-literal targets are refused even when listed.
- Oversized and slow responses are cut off at their caps.
- `always_ask` pauses before the fetch, and a deny never fetches.
- A search result from a host outside `allowed_hosts` is dropped, even if the
  provider returns it.
- Searches count in `server_tool_use.web_search_requests`.
- Conversion runs off the event loop: a slow page does not stall other
  sessions.

## Out of scope

Server tools through Pi (#249), `web_fetch` citations, PDFs and images,
`url_sources` and `max_content_tokens` configuration (accepted but not
honoured: rejected with an honest 400 until supported).
