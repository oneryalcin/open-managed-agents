# 0149 — Web tools (`web_fetch`, `web_search`)

## Status

Implemented 2026-10-09: 1a #293, 1b #294, 1c #295, 1d #296, D4 #297,
search #299, search usage #300, docs (this). Follow-up: #298 (re-check the
environment against the provider on sandbox rebuild).

Accepted 2026-10-09 after two Codex reviews, a Fable review and probe 72's
edge run. Proposed 2026-10-09. An M2 item in [0145](0145-road-to-external-testers.md)
(PARITY pre-v1 arc 3). Decisions D1–D3 made by the maintainer on 2026-10-09:
D1 (a), D2 (b), D3 (b). Revised after Codex and Fable review and probe 72's
edge run; D4 decided the same day: accept allowed hosts for web tools where
the sandbox has no egress.

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

## Chosen design (revised after review, 2026-10-09)

Codex and Fable reviewed the first version; probe 72's edge run answered the
two hosted questions they raised. Changes are marked **(review)**.

**Who may be reached.**
- **(review) The full egress policy, not just the hostname.** A URL is
  authorized against the environment's resolved `EgressPolicy`, using the
  same matcher as the egress proxy: protocol, effective port and native
  `pathPrefix` included. Hosted entries mean `https` on port 443, so
  `https://allowed.example:8443/` is refused. Export a `findAllowEntry(policy,
  url)` from `egress/policy.ts`, used by the proxy, `web_fetch`, and the
  search result filter. Native `credentials` are never injected into these
  fetches.
- **(review) Fail closed.** With absent networking or no allowed hosts, both
  tools return hosted's `url_not_allowed` with no outbound request at all, so
  no query reaches a search provider either. `unrestricted` is rejected by
  OMA's parser today, so there is no "any host" mode (the earlier `"any"`
  branch is gone).
- **(review) Hosted's prior-context rule (probe 72).** A URL may be fetched
  only if it was shown earlier in the session. Otherwise the result is
  `url_not_in_prior_context`, with hosted's wording. This is the main guard
  against a prompt-injected model exfiltrating data in a URL to an allowed
  host, which matters more in OMA: with no sandbox egress, `web_fetch` is the
  only way out. The contract (tightened after the second review):
  - **Shown sources**, read from persisted events:
    - `user.message` text (the user's own intent, delivered or not);
    - the text of successful `web_search` results;
    - the converted text, links included, of successful `web_fetch`
      results;
    - `user.custom_tool_result` content, which the client supplies.
  - **Not counted:**
    - MCP tool results (a third-party server could plant URLs);
    - error results;
    - anything past a truncation cut (only the model-visible, capped text
      counts).
  - **Expiry:** URLs from a fetched page count for 30 minutes from that
    fetch's `processed_at` (hosted: "for a while"). User messages, search
    results and custom tool results don't expire. Because the rule reads
    persisted times, a rebuilt session keeps the same answer.
  - **Matching:** both URLs are canonicalized (lower-case scheme and host,
    default port and fragment dropped, percent-encoding normalized), then
    compared exactly. A near-match differing only by http/https, `www.` or a
    trailing slash fetches the shown URL, with hosted's note.
- **(review) One URL validator** for the initial URL, a near-match
  substitute, and every redirect target, before any dial. It refuses:
  - anything that isn't `https`, so a redirect cannot downgrade to http even
    where a native policy entry allows http;
  - userinfo, or a URL that looks like it carries a credential
    (`url_not_allowed`);
  - URLs longer than 250 characters;
  - anything the full policy check refuses (protocol, port, `pathPrefix`);
  - SSRF targets (private, metadata, IP literals).
- **(review) Redirects are followed, as hosted does:** at most 5 hops,
  relative `Location` resolved against the current URL, every hop through
  the validator. A redirect target is exempt only from the prior-context
  rule (hosted fetched `anthropic.com` → `www.anthropic.com`); a refused hop
  ends with `url_not_allowed`, naming the target. Uses a
  `redirect: "manual"` variant of the guarded fetch, moved to
  `egress/guarded-fetch.ts`.

**D4 (decided 2026-10-09): deployments without sandbox egress accept allowed
hosts for web tools.** Today a session whose environment lists allowed hosts
is refused unless docker-local egress is configured (`assertEgressHonorable`).
On a deployment without sandbox egress (no sandbox, microsandbox, or docker
without the sidecar), such an environment is now accepted when its agent
enables a web tool. The allowed hosts then govern `web_fetch` and
`web_search` only, and the sandbox keeps `--network none`. This is a visible
divergence: `curl` in the sandbox fails where `web_fetch` succeeds. It is
stated in PARITY.md and the tester brief. Native policies with `credentials`
are still refused there.

**Fetching and converting.**
- **(review) The worker is for isolation, not just fairness.** Measured:
  ordinary pages take 15–230 ms, but link- or list-dense HTML takes 2.4 s and
  300 MB per MB, and a 550 KB nesting bomb ran 70 s before overflowing the
  stack. So:
  - conversion runs in a bounded pool of one or two workers, with
    `resourceLimits` on memory;
  - a hard deadline of about 5 s, enforced by `worker.terminate()`;
  - the worker is also terminated on interrupt or abort;
  - an overflow or timeout returns an honest `is_error`;
  - the HTML cap is 1 MB, enforced while streaming (Content-Length can lie),
    with a 20 s fetch timeout and `signal` passed to undici.
- The charset is decoded from Content-Type or the meta tag before
  conversion. The User-Agent identifies OMA.
- **(review) The output cap honours `max_content_tokens`** when the agent
  config sets it (a cap is safe to honour). The default is about 100k
  characters.

**Events and Pi.** **(review)** Pi's tool results carry only text and image
blocks, so the hosted `document` block cannot pass through Pi. Like MCP
(`mcp/bridge.ts`), the web tools publish their own `agent.tool_use` and
`agent.tool_result` (with the `document` block), return plain text to Pi,
and are added to `customToolNames` so the translator suppresses Pi's copies,
and to the expected tool surface. Share one control-plane-tool bridge with MCP
rather than a third near-copy of `publishToolUse`.

**Search provider (D2 b, Tavily first, kept after review).**
- **What Tavily does:** its `include_domains` (with mode `restrict`) maps onto
  the allowed hosts, and it returns plaintext `{title, url, content}`. (The
  Messages API server search returns encrypted content only, so it could not
  give hosted's plaintext blocks anyway.)
- **(review) Domains sent:** local, private and internal names are dropped.
  `*.example.com` is sent as `example.com` and the post-filter drops the bare
  host. Results are checked again with `findAllowEntry`. If nothing remains,
  the result is `url_not_allowed`.
- **(review) The provider endpoint is a fixed, operator-configured trust grant**,
  separate from the session allowlist. It is called only with the SSRF guard,
  with redirects refused so the bearer key cannot be redirected. Confirmation
  (`always_ask`) runs before the query is sent. Docs say plainly that
  `allowed_hosts` limits results, not who receives the query.
- **(review) Key handling:** the key comes from `OMA_WEB_SEARCH_API_KEY` or
  `_FILE`, operator-wide (SecretsStore is per workspace, so it does not fit).
  The live key is scrubbed from every provider-controlled string and error
  before truncation, persistence, logging or return to the model, reusing
  the MCP scrubbing.
- **(review) Counting:** only successful searches count in
  `web_search_requests`.

**(review) Tool config parity.** Materialize hosted's tool config shape
(`allowed_domains`, `blocked_domains`, `max_content_tokens`, `url_sources`,
search `user_location`, all null unless set). Restrictions that cannot be
honoured are rejected with a 400; ignoring a restriction is not safe. Today's
unsupported-tool list (`OMA_UNSUPPORTED_BUILTIN_TOOL_NAMES`) becomes a
deployment capability input, since `web_search` depends on a configured
provider.

**Module placement.** The web tools go in `sessions/pi/web/`, mirroring
`mcp/`, rather than growing `runner.ts`, which already has 1861 lines.

## Slices

1. **`web_fetch`**, in four reviewable PRs:
   - **1a. Security core:**
     - `findAllowEntry` exported from `egress/policy.ts` and shared with the
       proxy;
     - the one URL validator;
     - the guarded fetch moved to `egress/guarded-fetch.ts`, with a
       manual-redirect variant that follows up to 5 validated hops and has
       streaming byte and time caps.
     - Tests only, no tool yet.
   - **1b. Conversion:** turndown in a bounded worker pool with memory,
     deadline and abort limits; charset handling; output caps.
   - **1c. Provenance:** the set of shown URLs from persisted events, with
     expiry and near-match.
   - **1d. The tool:**
     - the shared control-plane-tool bridge with MCP;
     - events, permissions, config parity;
     - D4 admission;
     - API tests against a local HTTPS fixture.
2. **`web_search`** (D2): the provider interface, Tavily, domain scoping on
   request and result, key scrubbing, usage counting, and a credential-gated
   live smoke.
3. **Docs:** PARITY.md, and the tester brief: web access follows the
   environment's allowlist, and the sandbox stays offline under D4.

## Tests that prevent real bugs

- A host, port or path outside the policy is refused before any connection,
  and so is a redirect hop to one.
- With no allowed hosts, both tools make zero outbound requests, including to
  the search provider.
- A URL never shown in the session is refused (`url_not_in_prior_context`); a
  near-match fetches the shown URL with the note.
- A discarded steered message still counts as shown. A failed result, text
  past a truncation cut, and an MCP result do not count. A page link expires
  after 30 minutes, and the same answer holds after a restart.
- A redirect to `http`, to a userinfo URL, to an over-long URL, or to a port or
  path the policy refuses is not followed. A relative `Location` resolves
  correctly.
- D4: host-passthrough and native `credentials` stay rejected, and Docker and
  microsandbox sandboxes keep `--network none` when web tools are enabled.
- Userinfo, private, metadata and IP-literal targets are refused.
- A nesting-bomb page returns `is_error` within the deadline. An interrupt
  terminates the worker. Oversized and slow bodies are cut off.
- `always_ask` pauses before any network access, and a deny makes none.
- The search key never appears in any persisted event, log line, or model
  result, even when the provider echoes it.
- A provider result outside the allowed hosts is dropped. Only successful
  searches count in usage.

## Out of scope

Server tools through Pi (#249), `web_fetch` citations, PDFs and images,
`url_sources` and `max_content_tokens` configuration (accepted but not
honoured: rejected with an honest 400 until supported).
