# Probe 72 — hosted `web_fetch` / `web_search` (0145 M2, web tools)

Run with the CWC probe credential:

```bash
set -a; source /Users/oner/dev/junk/cwc-workshops/.env; set +a
uv run --with anthropic python scratch/72-managed-agents-web-tools-probe.py
OMA_WEB_PROBE_HOSTS=example.com,www.anthropic.com uv run --with anthropic python scratch/72-managed-agents-web-tools-probe.py
```

`claude-sonnet-5`; an agent with only `web_fetch` and `web_search` enabled
(`always_allow`, and `always_ask` for a fetch); a `limited` environment.
Run 1 with no `allowed_hosts`, run 2 with `example.com, www.anthropic.com`.

## Observed result (2026-10-09)

Artifacts: `artifacts/72-managed-agents-web-tools-probe-no-hosts.json`,
`artifacts/72-managed-agents-web-tools-probe-hosts.json`.

- **Ordinary builtin tool events**: `agent.tool_use` (`name: web_fetch`,
  input `{url}`; `name: web_search`, input `{query}`) then `agent.tool_result`.
  No server-tool event types.
- **Permission policies apply**: `always_ask` pauses with `requires_action`
  on the `agent.tool_use`; `user.tool_confirmation` allow runs it.
- **Both are scoped by the environment's `allowed_hosts`.** With none, both
  return an `is_error` tool result: `url_not_allowed` ("this session's
  environment allows no web hosts …"; for search "no host in this session's
  environment (its allowed_hosts) can be searched …").
- **`web_fetch` result**: one `document` block, `source: {type: "text",
  media_type: "text/plain", data: <page converted to text, with a small
  front-matter header>}`, `title`, `context: null`.
- **`web_search` result**: `content` is a JSON string of search result
  blocks with citations, only from allowed hosts (`www.anthropic.com`).
- **Usage**: a search counts `server_tool_use.web_search_requests: 1`; a
  fetch counts nothing (`web_fetch_requests: 0`). Search looks like the
  Anthropic server web search with `allowed_domains` = the allowed hosts;
  fetch looks harness-executed.

## Edge cases (run 3, 2026-10-09)

`OMA_WEB_PROBE_EDGES=1 OMA_WEB_PROBE_HOSTS=example.com,anthropic.com,www.anthropic.com`;
artifact `artifacts/72-managed-agents-web-tools-probe-edges.json`.

- **URLs must have been shown first.** Asked to fetch "the home page of the
  domain example dot com" (writing the URL itself), the model's
  `https://example.com` is refused: `url_not_in_prior_context`. "A URL counts
  as shown when it appeared in a message from the user, in a web_search
  result, or in the text of a page fetched earlier (its links count too for
  a while)". After a search showed `https://example.com/cdn-cgi/trace`, that
  URL fetched fine.
- **Near-matches fetch the shown URL, with a note**: asking for
  `https://www.example.com/cdn-cgi/trace` fetched the shown
  `https://example.com/cdn-cgi/trace` with "Note: fetched …, not the URL you
  gave … If it differs from yours by more than http or https, www. or a
  trailing slash, the content below is that page's".
- **Redirects are followed**: `https://anthropic.com` (in the user message)
  returned www.anthropic.com's page (both hosts allowed).
- The fetcher identifies as `Claude-User/1.0` (seen in the trace page).
