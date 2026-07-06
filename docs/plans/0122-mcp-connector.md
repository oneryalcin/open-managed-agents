# 0122 — MCP connector (capability track): execution first, vaults second, OAuth third

Date: 2026-07-06
Roadmap: [0114](0114-appliance-product-roadmap.md) capability track item 3
("MCP server connections — MCP TS SDK client; tokens via `SecretsStore`,
injected at the boundary"). Precondition [ADR 0016](../adrs/0016-egress-proxy-and-secret-injection.md)
(egress + secrets) shipped 2026-07-06. This plan lands the third appliance
exit criterion's MCP half: *"an agent in a workspace can use … one MCP server
whose credentials it cannot read."* Skills (capability item 2) is deliberately
sequenced after — MCP has the strongest pre-laid seams (§2) and the freshest
upstream evidence (§3).

**Handoff plan.** `file:line` against `main` at `e48a28b`; re-confirm before
editing.

**Slicing.** Three stacked slices, each its own PR chain. This plan specifies
**M1 (MCP execution, unauthenticated)** fully and sketches M2/M3 (§7):

- **M1** — agent-side strict validation, control-plane MCP client
  (streamable HTTP only), tool bridge into Pi, `agent.mcp_tool_use` /
  `agent.mcp_tool_result` events, permission gating (`always_ask` default),
  `session.error` connect-failure semantics. No auth of any kind.
- **M2** — `/v1/vaults` + credentials CRUD on `SecretsStore`; `static_bearer`
  injection by exact-URL match; `vault_ids` on session create;
  `mcp_authentication_failed_error`. Closes the exit criterion.
- **M3** — `mcp_oauth` credential type + refresh worker +
  `mcp_oauth_validate`.

---

## 1. Why this slice exists / definition of done (M1)

`mcp_servers` is today a hollow schema: typed, validated (shallowly), stored
as a JSON blob, echoed back — and ignored by the runtime, the translator, the
event registry, and the console. An agent declaring an MCP server gets
silently nothing, which is the "demos poorly" gap 0114 names.

**Definition of done (M1):**

- Creating an agent with `mcp_servers` + `mcp_toolset` enforces the upstream
  validation contract (§4.1): both-ways referencing, unique names, ≤ 20
  servers, length caps, http(s) URL. Existing shallow validation extended,
  no schema migration needed (storage already round-trips the field).
- A session whose agent declares an MCP server connects to it from the
  **control plane** (never the sandbox) over **streamable HTTP only**,
  discovers its tools, and exposes them to Pi alongside builtin/custom tools.
- The model calling an MCP tool produces `agent.mcp_tool_use` and
  `agent.mcp_tool_result` events with the exact upstream payload shapes
  (§3.2), correlated by top-level `sevt_*` event id (ADR 0011 model).
- `mcp_toolset` `default_config`/`configs` enable/disable filtering works by
  bare tool name; `permission_policy` works with upstream's default of
  `always_ask`, riding the **existing** pending-confirmation store
  (`user.tool_confirmation` with the `agent.mcp_tool_use` event id).
- An unreachable server does **not** fail session creation: the session
  starts, a `session.error` with `mcp_connection_failed_error` +
  `retry_status` is emitted, the session works without that server's tools,
  and connection is retried on the next idle→running transition (§4.6).
- Control-plane outbound MCP dials are **SSRF-guarded** with the existing
  pinned-lookup deny-list (`egress/ssrf.ts`) — an agent-supplied `url`
  resolving to loopback/RFC1918/link-local (incl. 169.254.169.254) must not
  connect (§4.3).
- Docs: dev-deployment MCP section; README + roadmap status updated;
  `docs/references/managed-agents-event-topology.md` rows flipped.

**Non-goals for the whole plan: §8.** Non-goals for M1 specifically: all
auth (M2/M3), >100K-token output spill-to-file, console UI for MCP servers,
legacy HTTP+SSE transport, WebSockets, stdio.

---

## 2. Current-state map (verified 2026-07-06 at `e48a28b`)

**Wire acceptance without runtime (the hollow shell):**

- `src/types/agents.ts:64-68` `ManagedAgentsMcpServer { type: "url"; name; url }`;
  `:36-44` `ManagedAgentsMcpToolset { type: "mcp_toolset"; mcp_server_name; default_config?; configs? }`
  — the toolset already carries the config-filtering fields.
- `src/control-plane/agents/service.ts:263-282` `mcpServerArrayField` —
  enforces `type === "url"` and non-empty `name`/`url`, nothing else.
  `:214-222` `parseTool` accepts `mcp_toolset` with required
  `mcp_server_name` and optional `default_config`/`configs`. **No
  cross-validation** (dangling toolsets and unreferenced servers pass), no
  uniqueness, no count/length caps, no URL syntax check.
- `src/control-plane/agents/store.ts:21,128,229` — `mcp_servers TEXT NOT
  NULL`, JSON round-trip. Storage is done; M1 adds no migration.
- `src/control-plane/sessions/service.ts:961` — `vault_ids` explicitly
  rejected (`rejectUnsupportedField`). Stays rejected until M2.
- `src/types/events.ts:19-41` `EVENT_TYPES` — **no**
  `agent.mcp_tool_use`/`agent.mcp_tool_result`.
- `ui/managed-agents-console/src/agents-files.jsx` — an "MCPs and tools"
  section label with no MCP rendering behind it (stays that way in M1, §8).

**Pre-laid seams M1 plugs into (each verified in code this session):**

- **Custom-tool bridge as the template.**
  `src/control-plane/sessions/pi/custom-tools.ts:56-81` wraps each custom
  tool via Pi's `defineTool({name, description, parameters: input_schema,
  execute})`; `runner.ts:651-659` concatenates sandbox tools + bridge tools
  into `createAgentSession({customTools, tools, noTools: "builtin"})`
  (`runner.ts:660-674`). MCP tools are a third source in that
  concatenation — with one big simplification: `execute` resolves
  control-plane-side (an MCP `callTool`), no user round-trip.
- **Permission machinery.** `pi/tool-permissions.ts` (`BuiltinToolAccess
  {enabled, permission: "allow"|"ask"|"deny"}`, resolver at `:22-27`,
  `PiToolPermissionBridge.wrapTool` used at `runner.ts:722-730`) and the
  pending-confirmation store (plan 0015-0038) were designed MCP-compatible:
  `user.tool_confirmation.tool_use_id` is documented upstream as the
  top-level id of `agent.tool_use` **or `agent.mcp_tool_use`** (hosted probe
  32 + SDK types).
- **Session lifecycle.** `runner.ts:548-633` `ensureSession` builds the
  per-session `RuntimeHandle` inside an async IIFE with full
  cleanup-on-error; the MCP connection set belongs on that handle, created
  there, disposed where sandbox/session are disposed (`:596-597`, `:613-614`,
  eviction).
- **Translator suppression.** `pi/translator.ts:61` suppresses custom-tool
  `toolCall` blocks from generic `agent.tool_use` emission by name set;
  `:84` same for `tool_execution_end` → `agent.tool_result`. MCP tool names
  need the same suppression (their events are emitted by the MCP bridge
  instead, §4.5).
- **SSRF guard.** `src/control-plane/egress/ssrf.ts` exports
  `isBlockedAddress` (`:77`) and `createPinnedLookup` (`:93`) —
  resolve-once, reject-if-any-blocked, connect-to-pinned-IP (no TOCTOU).
  `egress/proxy.ts:101-109` shows the established **test seam**: an
  explicit unsafe flag swaps in `createPinnedLookup({allowAddress: () =>
  true})` so tests can dial loopback fixtures. Never derived from request
  input.
- **Placement decision.** `docs/architecture.md` ("MCP tool routing …
  control plane ✅"): the sandbox never dials MCP servers and (in M2+) never
  sees credentials — the exit criterion's "cannot read" is by construction.

**Decided-by-inheritance (docs):** ADR 0011 (`sevt_*` top-level ids, Pi
`toolu_*` stays payload-side), ADR 0005 (MCP tools are the same
blocking-async-function shape as custom tools; in-house MCP transport
explicitly rejected), ADR 0016 §4 (MCP OAuth creds flow through
`SecretsStore` + boundary injection; refresh via MCP TS SDK / openid-client),
scope.md deferral, event-topology rows "Deferred".

---

## 3. Wire contract (upstream evidence, all captured 2026-07-06)

Sources, strongest first: **(a)** `@anthropic-ai/sdk` (latest, installed
fresh) `resources/beta/sessions/events.d.ts` + `resources/beta/vaults/*` —
generated from the same OpenAPI spec as the platform API reference;
**(b)** official docs crawl at `/tmp/claude-docs/docs/managed-agents/`
(`mcp-connector.md`, `vaults.md`, `reference.md`, `tools.md`); **(c)** the
claude-api skill's `shared/managed-agents-*.md`. Where prose and SDK types
disagree, SDK types win.

### 3.1 Agent + session config

- `mcp_servers: [{type: "url", name, url}]` — `name` unique within the
  array, 1–255 chars; `url` ≤ 2048 chars; ≤ 20 servers per agent; server
  must support **streamable HTTP** (docs `reference.md`: remote servers or
  MCP tunnels; no stdio, no WebSocket, legacy SSE not mentioned).
- **Both-ways referencing is rejected upstream:** every `mcp_servers` entry
  must be referenced by an `mcp_toolset` in `tools`, and every `mcp_toolset`
  must reference a declared server (`mcp-connector.md` Constraints).
- `mcp_toolset` supports `default_config`/`configs` with the same shape as
  the builtin toolset; `configs[].name` is the **bare tool name as reported
  by the server**; default = all tools enabled; `permission_policy`
  supported per-tool and per-toolset, **MCP toolset defaults to
  `always_ask`** (`mcp-connector.md` Tip).
- Upstream also allows `agent_with_overrides` on session create and
  `sessions.update` of `agent.mcp_servers`/`vault_ids` while idle. OMA has
  no agent-override surface at all today — out of scope (§8), tracked as a
  parity gap.

### 3.2 Events (SDK types, exact)

```
agent.mcp_tool_use   { id, type, processed_at, mcp_server_name, name,
                       input: object, evaluated_permission?: "allow"|"ask"|"deny",
                       session_thread_id?: string|null }
agent.mcp_tool_result{ id, type, processed_at,
                       mcp_tool_use_id,        // = the agent.mcp_tool_use event's id
                       content?: (text|image|document|search_result blocks)[],
                       is_error?: boolean|null }
```

`user.tool_confirmation.tool_use_id` accepts the `agent.mcp_tool_use` event
id — same confirmation path as builtin tools. Note `agent.mcp_tool_use` has
**no** payload-level `tool_use_id` field (unlike `agent.tool_use`):
correlation is purely top-level-event-id.

### 3.3 Failure semantics

`session.error` error union gains (SDK types):

```
{ type: "mcp_connection_failed_error",     mcp_server_name, message, retry_status }
{ type: "mcp_authentication_failed_error", mcp_server_name, message, retry_status }   // M2
retry_status: { type: "retrying" } | { type: "exhausted" } | { type: "terminal" }
```

Session creation does **not** validate MCP connectivity. On failure the
session still starts; connection is retried on the next
`session.status_idle` → `session.status_running` transition
(`mcp-connector.md`). With no matching credential the connection is
attempted **unauthenticated** (`vaults.md`) — which is why M1 needs no auth
to be wire-correct.

### 3.4 Client dependency (probed, not assumed)

`@modelcontextprotocol/sdk@1.29.0` probed live this session (in-process
streamable-HTTP server + client on loopback, scratchpad `mcp-probe.mjs`):

- `new Client({name, version})` +
  `new StreamableHTTPClientTransport(new URL(url), opts)`;
  `opts.fetch?: FetchLike` (our SSRF seam, §4.3) and
  `opts.requestInit?: RequestInit` (M2's bearer-header seam) both exist in
  the shipped types; `opts.authProvider` exists for M3 evaluation.
- `client.listTools()` → `{tools: [{name, description, inputSchema}]}` with
  `inputSchema` as standard JSON Schema — **directly assignable** to
  `defineTool`'s `parameters` (the custom-tool bridge already passes raw
  JSON Schema through, `custom-tools.ts:68`).
- `client.callTool({name, arguments})` → `{content: [{type: "text", ...}]}`
  (+ `isError`).
- Server-side note for test fixtures: `StreamableHTTPServerTransport` in
  stateless mode (`sessionIdGenerator: undefined`) requires a
  transport-per-request; the fixture uses stateful mode.

---

## 4. Design (M1)

### 4.1 Agent-side validation (`agents/service.ts`)

Extend `mcpServerArrayField` + a new post-parse cross-check in
`parseCreateAgent`:

- per-server: `name` 1–255 chars; `url` ≤ 2048, parses via `new URL`,
  scheme `http:`/`https:`; `rejectUnknownFields` on
  `{type, name, url}`.
- array: ≤ 20 entries; names unique.
- cross: set-equality between declared server names and the
  `mcp_server_name`s of `mcp_toolset` entries — dangling toolset or
  unreferenced server → `invalid_request_error` with the offending name in
  the message. (Also rejects two `mcp_toolset` entries naming the same
  server — upstream toolsets are per-server.)
- No validation of reachability, and **no SSRF check at create time** —
  the URL's resolution is a connect-time property (DNS changes); rejecting
  at create would be both bypassable and a parity break. The guard lives at
  dial time (§4.3).

Existing stored agents predate the cross-check; validation applies at
create/update only (same posture as every prior validation tightening).

### 4.2 MCP client manager (`sessions/pi/mcp/client.ts`, new)

One `McpConnection` per (session, declared server), owned by the
`RuntimeHandle`:

- Created inside `ensureSession`'s IIFE (after sandbox setup, before
  `createAgentSession`): connect → `listTools()` → build filtered
  `ToolDefinition`s (§4.4). Connect/discovery failure is **caught**, never
  propagated: record the failure on the handle, emit
  `mcp_connection_failed_error` (§4.6), continue with the remaining
  servers' tools.
- Per-operation timeout (default 60s, deployment-configurable) on connect,
  listTools, and callTool.
- Disposed (`client.close()`) everywhere the handle's sandbox/session are
  disposed: creation-failure cleanup (`runner.ts:596-598`), closed-race
  cleanup (`:612-621`), eviction, `rejectSession`, runner close.
- Tool list is fetched once per connection (no `listChanged`
  subscription in M1 — §8).

### 4.3 SSRF guard on control-plane dials

The transport takes a custom `fetch`. We supply one whose dialer resolves
the hostname once through `createPinnedLookup()` (`egress/ssrf.ts:93`) and
connects to the vetted address, preserving the hostname for TLS SNI — the
same no-TOCTOU property the egress proxy has. Concretely: a small
`undici.Agent` with `connect: {lookup: pinnedLookup}` passed as the
transport's `fetch` (undici added as an explicit dependency — Node's global
fetch is undici but doesn't expose dispatcher wiring on the sealed global).
Implementation must include the **mutation check**: with the guard active, a
loopback fixture is unreachable (`mcp_connection_failed_error`); with the
test-only `allowAddress: () => true` seam (proxy.ts:108 precedent, wired
through runner opts, never request input), the same fixture connects.

Redirects: `requestInit.redirect = "error"` — a public URL 30x-ing to an
internal address is the classic guard bypass; MCP servers have no business
redirecting the RPC endpoint.

### 4.4 Tool bridge (`sessions/pi/mcp/bridge.ts`, new)

Mirrors `PiCustomToolBridge` but resolves locally:

- For each discovered tool that survives `mcp_toolset` filtering
  (`default_config.enabled` default true, `configs[].enabled` override by
  bare name — resolver mirroring `createStoreBackedBuiltinToolAccessResolver`,
  `tool-permissions.ts:364`): register
  `defineTool({name: piName, parameters: inputSchema, execute})`.
- **Model-visible Pi name is namespaced** `mcp__{server}__{tool}` to make
  cross-server collisions impossible and collisions with builtin/custom
  tools structurally excluded (extend
  `assertNoSandboxCustomToolNameCollision`, `runner.ts:580`, to cover the
  MCP set anyway). **Events carry the bare `name` + `mcp_server_name`**
  (§3.2) — wire parity is at the event layer; the model-visible name is not
  observable through the API. Flagged as probe-me-later (§9 open Q1).
- `execute` sequence:
  1. Evaluate permission (`allow`/`ask`/`deny`) from the toolset config
     (default **`always_ask`** per upstream — worth restating: an OMA agent
     with an MCP toolset and no `permission_policy` config will pause for
     confirmation on every MCP call, exactly like hosted).
  2. Emit internal `oma.mcp_tool_use` through the handle's `emitInternal`
     channel (the `oma.custom_tool_use` path, `custom-tools.ts:159-180`);
     the events service persists `agent.mcp_tool_use` with
     `evaluated_permission`, assigning the `sevt_*` id and binding it back
     (the `bindCustomToolUseId` pattern) for result correlation.
  3. `deny` → tool errors back to the model without executing. `ask` →
     await the pending-confirmation store (0015-0038 machinery;
     `requires_action` coalescing and interrupt/archive semantics already
     handle this event type by design); denial message, if any, returns to
     the model as the tool error (matches builtin deny flow).
  4. `callTool({name: bareName, arguments})` on the connection.
  5. Emit internal `oma.mcp_tool_result` with `mcp_tool_use_id` = the bound
     `sevt_*` id, `content` mapped (text → text; anything else →
     JSON-stringified text block, the `toPiToolContent` precedent —
     richer block mapping deferred, §8), `is_error` from `isError`.
  6. Return content to Pi (throw on `isError`, message from text content —
     same contract as `custom-tools.ts:188-190`).
- Output cap: callTool result text over a byte cap (default 400 KB,
  configurable) is truncated with an explicit
  `[truncated by oma: N bytes total]` marker in both the event and the
  model-visible result. Upstream's >100K-token spill-to-sandbox-file is
  deferred (§8) — truncation is honest and bounded; silent unbounded
  persistence is the thing to avoid.

### 4.5 Events & translator

- `types/events.ts`: add `"agent.mcp_tool_use"`, `"agent.mcp_tool_result"`
  to `EVENT_TYPES` + payload interfaces per §3.2. Both are emit-only
  (never client-sendable — the `events/service.ts` inbound allowlist at
  `:2779` is untouched).
- `RuntimeTranslatorContext` gains the MCP pi-name set;
  `translator.ts:61` and `:84` suppression extended so MCP `toolCall`
  blocks never leak as generic `agent.tool_use`/`agent.tool_result`. (The
  namespaced `mcp__` prefix makes an accidental leak grep-able in fixtures.)
- `docs/references/managed-agents-event-topology.md`: two rows Deferred →
  Implemented.
- Metrics (rides Arc C): `oma_mcp_tool_calls_total{outcome}`
  (`ok|error|denied|timeout`) and
  `oma_mcp_connections_total{event}` (`connected|connect_failed`) via the
  existing registry — closed label sets, registered in `instruments.ts`.

### 4.6 Failure semantics & retry

- Connect/discovery failure for server S: emit `session.error` with
  `{type: "mcp_connection_failed_error", mcp_server_name: S, message,
  retry_status: {type: "retrying"}}`; session proceeds without S's tools.
- Retry on idle→running: the connection attempt re-runs when the session
  next transitions to running (upstream contract §3.3). Mechanically: the
  handle marks failed servers; the run path retries them before
  prompting, and a successful retry registers the tools via
  `pi.registerTool`-equivalent (Pi SDK: replace `session.agent.state.tools`)
  — if that proves invasive in implementation, fallback is retrying only on
  **fresh handles** (evicted-and-recreated sessions), with the limitation
  documented in the PR and a follow-up issue; the event contract is
  unaffected either way.
- After N consecutive failed retries (default 5): `retry_status: {type:
  "exhausted"}`, stop retrying for the handle's lifetime. `terminal` is
  reserved (upstream uses it for session-terminating errors; no M1 path
  produces it).
- **Deployment gate:** MCP dialing is enabled by a deployment-config flag
  (`mcp: {enabled: boolean}`), **default off**, consistent with every other
  outbound-capability opt-in (sandbox providers, egress). Disabled + agent
  declares servers → session still starts, one
  `mcp_connection_failed_error` per server with `message: "MCP is disabled
  by deployment configuration"`, `retry_status: {type: "exhausted"}`, no
  dial attempted. Agent creation is **not** rejected (agents are portable
  configs). Reviewers: sanity-check the default (§9 open Q2).

---

## 5. Testing (M1)

Fixture: in-process `@modelcontextprotocol/sdk` streamable-HTTP server on
loopback (stateful transport — §3.4 note), reached through the
`allowAddress` test seam. No network, no mocks of the protocol itself.

- **Validation matrix** (`agents/__tests__`): both-ways cross-check (each
  direction), duplicate names, duplicate toolsets per server, 21 servers,
  256-char name, 2049-char URL, `ftp://` scheme, unknown server fields.
- **Bridge e2e** (`pi/__tests__`): agent with MCP toolset → session → model
  fixture calls tool → assert persisted `agent.mcp_tool_use` (bare name,
  `mcp_server_name`, `evaluated_permission`) then `agent.mcp_tool_result`
  (`mcp_tool_use_id` = the use event's id, content, `is_error`) — and that
  **no** generic `agent.tool_use`/`agent.tool_result` was emitted for the
  call (translator suppression, one test per direction).
- **Permission flow**: default (no `permission_policy`) pauses with
  `requires_action`; `user.tool_confirmation` allow → executes; deny with
  message → no MCP call made (fixture asserts zero server hits), model sees
  the deny message; `configs[].enabled: false` tool absent from Pi's
  surface.
- **Filtering**: `default_config.enabled false` + explicit allowlist
  enables exactly the listed tools.
- **Failure semantics**: unreachable URL → session starts, error event with
  `retrying`; disabled deployment flag → `exhausted` + zero dials; N
  failures → `exhausted`; `callTool` throwing → `mcp_tool_result` with
  `is_error: true` and `oma_mcp_tool_calls_total{outcome="error"}`.
- **SSRF mutation pair** (§4.3): guard on → loopback fixture unreachable;
  test seam → reachable. Plus `redirect: "error"` behavior (fixture 302 →
  connect failure, not a followed redirect).
- **Output cap**: oversized text result truncated with marker in event +
  model result.
- **Live hosted probe** (separate scratch, before merge, pattern of probe
  32): create a hosted agent with a public MCP server, capture real
  `agent.mcp_tool_use`/`mcp_tool_result` frames, diff against our fixtures.
  Resolves open Q1. If no API access at implementation time, ship gated on
  SDK-types parity and file the probe as a follow-up issue (0015-0038's
  "don't fake it" rule: no claimed hosted parity without the probe).

Suite discipline: `pkill -f vitest` first, foreground
`npx vitest run --no-file-parallelism` with output redirected to scratch.

---

## 6. Docs (M1)

- `docs/dev-deployment.md`: "MCP servers" section — deployment flag,
  streamable-HTTP-only support statement, SSRF posture (what will refuse to
  connect and why), permission default (`always_ask`), failure/retry
  semantics, wrap-stdio-servers-with-a-shim pointer.
- `docs/threat-model.md`: new row/paragraph — control-plane outbound dials
  to agent-declared URLs are a new egress class, mitigated by pinned-lookup
  deny + redirect refusal + deployment gate; credentials story unchanged
  until M2 (then: injected control-plane-side, never sandbox-visible).
- `docs/architecture.md` MCP row: post-MVP → M1 shipped (control plane,
  streamable HTTP).
- `README.md` capability line, roadmap 0114 item 3 → in progress/DONE per
  slice, `docs/scope.md` deferred list amended (MCP execution no longer
  deferred; vaults stays deferred until M2).

---

## 7. M2 / M3 sketch (not specified here; each gets a plan amendment before implementation)

- **M2 — vaults + `static_bearer`.** `/v1/vaults` + nested credentials CRUD
  (SDK shapes captured: `BetaManagedAgentsVault {id, display_name, metadata,
  created_at, updated_at, archived_at, type}`; credential fields write-only;
  `mcp_server_url` unique per vault among active credentials, 409 on
  duplicate, structural fields immutable → archive-and-recreate). Values in
  `SecretsStore` (0118), metadata rows in a new table. Session create
  accepts `vault_ids` (drop `service.ts:961` rejection); connect-time
  credential resolution by **exact URL match**; injection via the
  transport's `requestInit` Authorization header — control-plane-side only.
  `mcp_authentication_failed_error` on 401/403. Exit criterion test: agent
  session calls a bearer-protected MCP fixture; sandbox-side grep proves the
  token appears nowhere in the sandbox or event stream (the 0121 redaction
  chokepoint already covers logs).
- **M3 — `mcp_oauth` + refresh.** Credential type with `refresh` block
  (`token_endpoint`, `client_id`, `scope`, `refresh_token`,
  `token_endpoint_auth: none|client_secret_basic|client_secret_post`);
  refresh on expiry (re-encrypt + persist, ADR 0016), retry/backoff;
  `mcp_oauth_validate` endpoint (`valid|invalid|unknown` semantics);
  re-resolution propagating to running sessions. Evaluate SDK
  `authProvider` vs. plain header + own refresh loop at M3 planning time
  (buy-vs-build note points at MCP SDK / openid-client mechanics). **No
  OAuth authorization flow ever** — upstream's product boundary (the API
  consumer runs the dance; the platform stores/injects/refreshes) is ours
  too.

---

## 8. Non-goals (whole plan)

- **stdio / WebSocket / legacy HTTP+SSE transports** — upstream is
  streamable-HTTP-only (`type: "url"`); operators can shim stdio servers.
  Parked deliberately (user call, 2026-07-06).
- **OAuth authorization UX** (redirect/callback/consent/dynamic client
  registration) — outside the API boundary by upstream design (§7 M3).
- **`agent_with_overrides` / `sessions.update` of `mcp_servers`+`vault_ids`**
  — OMA has no session-override surface at all; separate parity item.
- **>100K-token spill-to-sandbox-file** — M1 truncates with a marker
  (§4.4); the file-spill needs sandbox-write plumbing that pulls the slice
  off its critical path.
- **Rich content-block mapping** (image/document/search_result from MCP
  results) — text + stringify fallback in M1.
- **`listChanged` tool-list subscriptions**, MCP resources/prompts/sampling
  — tools only, list fetched at connect.
- **Console UI for MCP servers** — the "MCPs and tools" section gets real
  rendering in a later console polish slice.
- **Env-var (`environment_variable`) vault credentials** — egress-proxy
  placeholder substitution; separate slice after M2 if wanted (the hosted
  platform doesn't support it on self-hosted sandboxes either).

---

## 9. Review log & open questions

Open questions for reviewers (to be resolved before or during review):

1. **Model-visible tool naming** (`mcp__{server}__{tool}` vs bare name with
   first-wins/reject on collision). Wire parity is unaffected (events carry
   bare name + server); the observable difference is prompt-side only. The
   live hosted probe (§5) can settle what hosted actually shows the model
   if we can capture a system-prompt-adjacent artifact; otherwise this is
   our call.
2. **Deployment gate default off** (§4.6) — parity purists could argue MCP
   should work out of the box like hosted; the opt-in posture matches every
   other outbound capability in the appliance. Which wins?
3. **Retry-on-idle→running mechanics** (§4.6) — live re-registration of
   tools on an existing Pi session vs. fresh-handle-only retry. The event
   contract is identical; the difference is how soon a recovered server's
   tools become usable without session eviction.

*(Reviewer findings and dispositions land here, 0121-style.)*
