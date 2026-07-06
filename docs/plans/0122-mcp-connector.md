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

**Reviewed 2026-07-06** by Codex (review + adversarial), Opus, and Sonnet
before implementation; all 24 findings accepted and folded in — disposition
log in §9. The structural change from review: §4.4's event plumbing is
modeled on the **tool-permission** bridge, not the custom-tool bridge.

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
  servers, length caps, http(s) URL — with the **raw URL string persisted
  unmodified** (M2's exact-match depends on it). Existing shallow validation
  extended, no schema migration needed.
- A session whose agent declares an MCP server connects to it from the
  **control plane** (never the sandbox) over **streamable HTTP only**,
  discovers its tools, and exposes them to Pi alongside builtin/custom tools.
- The model calling an MCP tool produces `agent.mcp_tool_use` and
  `agent.mcp_tool_result` events with the exact upstream payload shapes
  (§3.2), correlated by top-level `sevt_*` event id (ADR 0011 model) —
  and **every** `agent.mcp_tool_use` gets a terminal `agent.mcp_tool_result`
  on every path: success, in-band error, permission deny, confirmation
  timeout, abort, call timeout, transport failure (§4.4).
- `mcp_toolset` `default_config`/`configs` enable/disable filtering works by
  bare tool name; `permission_policy` works with upstream's default of
  `always_ask`, riding the tool-permission confirmation machinery (§4.4).
- An unreachable server does **not** fail session creation: the session
  starts, a `session.error` with `mcp_connection_failed_error` +
  `retry_status` is emitted, the session works without that server's tools,
  and connection is retried on the next idle→running transition —
  implemented via fresh-handle mechanics (§4.6), no unproven live
  re-registration.
- Control-plane outbound MCP dials are **SSRF-guarded** with the existing
  pinned-lookup deny-list (`egress/ssrf.ts`) on **both** transport channels
  (POST RPC + GET SSE stream) — an agent-supplied `url` resolving to
  loopback/RFC1918/link-local (incl. 169.254.169.254) must not connect, and
  the pinning property (no TOCTOU/rebinding) is tested as a property, not
  just as a static block (§5).
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

**Pre-laid seams M1 plugs into (each verified in code this session; the
review pass corrected which seam is the template — see §4.4):**

- **Tool-permission bridge as the event/confirmation template.**
  `pi/tool-permissions.ts` has everything the MCP event flow needs:
  id-bind-**before**-execute (`publishToolUse`, `:222-243`, resolve-on-bind
  — the property `mcp_tool_result.mcp_tool_use_id` requires), the
  `requires_action` coalescing trigger (`runner.ts:371`, fires on
  `oma.tool_permission_use`), the persistence pair
  (`events/service.ts:1296-1314`, `:2012`
  `persistToolPermissionUseWithModelEnd`), the pending-confirmation store
  (`tool-permissions.ts:55`) and the single inbound claim path
  (`events/service.ts:2329` → `runner.ts:192-202` →
  `toolPermissionBridge.claimConfirmation`). Two MCP-specific gaps in it:
  the coalescing message-end matcher (`runner.ts:943`
  `takeMessageEndForToolCall`) matches **sandbox-builtin** toolCalls only,
  and the bridge's typing/`access()` resolver assume
  `SandboxedBuiltinToolName` — both get widened (§4.4).
- **Custom-tool bridge as the Pi-registration template only.**
  `pi/custom-tools.ts:56-81` shows the `defineTool({name, description,
  parameters, execute})` wrap and content mapping (`:203-217`
  `toPiToolContent`); `runner.ts:651-659` concatenates sandbox + custom
  tools into `createAgentSession({customTools, tools, noTools: "builtin"})`
  inside `createPiSession` (`runner.ts:660-674`). Its *event* pattern
  (resolve-on-user-round-trip) is **not** the MCP model.
- **Session lifecycle.** `runner.ts:548-633` `ensureSession` builds the
  per-session `RuntimeHandle` inside an async IIFE with full
  cleanup-on-error. Two review-caught constraints: the Pi tool list is
  assembled inside `createPiSession` (`:635-676`), so MCP
  discovery must feed that call, not just "the IIFE"; and when
  `opts.sessionFactory` is set (`:589`) `createPiSession` is bypassed
  entirely — MCP e2e tests must run against the real `createPiSession` +
  fixture model, or they test nothing (§5).
- **`emitInternal` is not installed at session-build time** — it's wired
  when a runtime consumer attaches (`handle.emitInternal`,
  `runner.ts:610`). Connection-failure events discovered during session
  build must be **queued on the handle and flushed at turn start** (§4.2).
- **Translator suppression.** `pi/translator.ts:61` suppresses custom-tool
  `toolCall` blocks from generic `agent.tool_use` emission via
  `context.customToolNames`, sourced from `handle.customToolNames`
  (`runner.ts:242`, `events/service.ts:1318`); `:84` same for
  `tool_execution_end`. MCP pi-names join **that same set** (§4.5) — no new
  context field.
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

Sources, strongest first: **(a)** `@anthropic-ai/sdk` (1.x latest as of
2026-07-06, installed fresh) `resources/beta/sessions/events.d.ts` +
`resources/beta/vaults/*` — generated from the same OpenAPI spec as the
platform API reference; **(b)** official docs crawl at
`/tmp/claude-docs/docs/managed-agents/` (`mcp-connector.md`, `vaults.md`,
`reference.md`, `tools.md`, `environments.md`, `multi-agent.md`);
**(c)** the claude-api skill's `shared/managed-agents-*.md`. Where prose and
SDK types disagree, SDK types win. Client-SDK behavior is pinned by
**committed probe `scratch/46-mcp-sdk-client-probe.mjs`** (output:
`scratch/46-mcp-sdk-client-probe.md`).

### 3.1 Agent + session config

- `mcp_servers: [{type: "url", name, url}]` — `name` unique within the
  array, 1–255 chars; `url` ≤ 2048 chars; ≤ 20 servers per agent; server
  must support **streamable HTTP** (docs `reference.md`: remote servers or
  MCP tunnels; no stdio, no WebSocket, legacy SSE not mentioned).
- **Both-ways referencing is rejected upstream:** every `mcp_servers` entry
  must be referenced by an `mcp_toolset` in `tools`, and every `mcp_toolset`
  must reference a declared server (`mcp-connector.md` Constraints).
- **URL matching is byte-exact upstream** — `multi-agent.md` explicitly
  warns credentials match `mcp_servers[].url` "exactly, including scheme
  and trailing slash". Consequence for M1: persist the raw input string
  (§4.1).
- `mcp_toolset` supports `default_config`/`configs` with the same shape as
  the builtin toolset; `configs[].name` is the **bare tool name as reported
  by the server**; default = all tools enabled; `permission_policy`
  supported per-tool and per-toolset, **MCP toolset defaults to
  `always_ask`** (`mcp-connector.md` Tip).
- **MCP tool output over 100K tokens is spilled to a sandbox file**
  upstream (truncated preview + file path to the model). Known M1
  deviation: truncation with marker instead (§4.4, §8).
- Upstream also has a **per-environment reachability gate**: under
  `limited` sandbox networking, `environment.networking.allow_mcp_servers`
  (default false) gates MCP (`environments.md`). OMA has no per-environment
  networking object; M1's gate is deployment-wide (§4.6) and the
  per-environment axis is a **named parity gap** (§8).
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
(`mcp-connector.md`, stated unconditionally). The SDK doc comments describe
`retrying`→`exhausted` as a bounded retry budget running out; upstream
publishes no numeric budget. OMA's concrete budget in §4.6 is therefore an
**OMA policy choice**, labeled as such. With no matching credential the
connection is attempted **unauthenticated** (`vaults.md`) — which is why M1
needs no auth to be wire-correct.

### 3.4 Client dependency (probed, not assumed)

`@modelcontextprotocol/sdk@1.29.0`, probed via committed
`scratch/46-mcp-sdk-client-probe.mjs` (in-process streamable-HTTP server +
client on loopback; captured output in the companion `.md`):

- `new Client({name, version})` +
  `new StreamableHTTPClientTransport(new URL(url), opts)`;
  `opts.fetch?: FetchLike` ("used for all network requests" per the shipped
  `.d.ts` — our SSRF seam, §4.3; §5 verifies it covers the GET SSE channel
  too) and `opts.requestInit?: RequestInit` (M2's bearer-header seam) both
  exist in the shipped types; `opts.authProvider` exists for M3 evaluation.
- `client.listTools()` → `{tools: [{name, description, inputSchema}]}` with
  `inputSchema` as standard JSON Schema draft-07.
- `client.callTool({name, arguments})` → `{content: [...], isError?}`.
- **Error classes (probe-verified):** unknown tool, schema-invalid
  arguments, and a tool handler throwing internally all **resolve with
  `{isError: true}`** — `callTool` never throws for in-band failures. Only
  protocol-level failures (transport drop, timeout, unknown JSON-RPC
  method) **reject**. §4.4 handles the two classes differently.
- Server-side note for test fixtures: `StreamableHTTPServerTransport` in
  stateless mode (`sessionIdGenerator: undefined`) requires a
  transport-per-request; the fixture uses stateful mode.

---

## 4. Design (M1)

### 4.1 Agent-side validation (`agents/service.ts`)

Extend `mcpServerArrayField` + a new post-parse cross-check in
`parseCreateAgent`:

- per-server: `name` 1–255 chars; `url` ≤ 2048, parses via `new URL`,
  scheme `http:`/`https:`, **no embedded userinfo** (`user:pass@host` is
  rejected — a credential in a shared agent config is exactly the leak
  class this arc exists to prevent; **probe 47: hosted ACCEPTS these, so
  this is a deliberate OMA deviation**, documented in dev-deployment);
  `rejectUnknownFields` on `{type, name, url}`. **The raw input string is what gets persisted** —
  `new URL` is used to *check*, never to re-serialize (URL normalization
  would silently break M2's byte-exact credential matching, §3.1; test
  locks round-trip byte-equality).
- array: ≤ 20 entries; names unique (**case-sensitive**, as are all name
  comparisons in this plan: server-name↔`mcp_server_name` cross-check and
  `configs[].name` tool matching — locked by tests).
- cross: set-equality between declared server names and the
  `mcp_server_name`s of `mcp_toolset` entries — dangling toolset or
  unreferenced server → `invalid_request_error` with the offending name in
  the message. A non-empty `mcp_servers` with **no `tools` field at all**
  is the same rejection (unreferenced servers), called out so the
  undefined-`tools` code path can't skip the check. Two `mcp_toolset`
  entries naming the same server are rejected — **confirmed upstream
  behavior by live probe 47** (hosted 400: "each MCP server may have at
  most one mcp_toolset"), not an OMA tightening.
- No validation of reachability, and **no SSRF check at create time** —
  the URL's resolution is a connect-time property (DNS changes); rejecting
  at create would be both bypassable and a parity break. The guard lives at
  dial time (§4.3).

Existing stored agents predate the cross-check; validation applies at
create time (agents are create-only today — no update endpoint), the same
posture as every prior validation tightening.

### 4.2 MCP client manager (`sessions/pi/mcp/client.ts`, new)

One `McpConnection` per (session, declared server), owned by the
`RuntimeHandle`:

- **Where it runs:** connect → `listTools()` → build filtered
  `ToolDefinition`s happens inside `createPiSession` (`runner.ts:635-676`)
  — that is where the `customTools`/`tools` arrays for
  `createAgentSession` are assembled; the plan's tools must land there.
  The `sessionFactory` branch (`runner.ts:589`) bypasses `createPiSession`
  and therefore gets no MCP tools — e2e tests must not use it (§5).
- **Failure is captured, never propagated:** connect/discovery failure for
  a server is recorded on the handle as a *queued* connection-failure
  (`{server, message}`), because `handle.emitInternal` does not exist yet
  at session-build time. Queued failures are **flushed as
  `session.error` events at turn start**, when the runtime consumer
  attaches — the same moment the coalescing machinery becomes live. The
  session proceeds with the remaining servers' tools.
- **Concurrency:** all of a server's tool calls share one
  `Client`/transport; the MCP SDK multiplexes concurrent requests over one
  transport by JSON-RPC id (implementation verifies with a two-parallel-
  calls probe before relying on it, and sets `executionMode: "parallel"`
  on the MCP `ToolDefinition`s — Pi issues parallel tool calls today).
- **Abort/disposal races:** Pi's `execute(signal)` is threaded into
  `callTool({signal})`; a rejection caused by `client.close()` on an
  in-flight call surfaces as a tool error (and a terminal
  `mcp_tool_result`, §4.4), never an unhandled rejection — mirroring the
  `signal`/`cleanup` handling in `custom-tools.ts:136-156` and
  `tool-permissions.ts:279-291`.
- Per-operation timeout (default 60s, deployment-configurable) on connect,
  listTools, and callTool.
- Disposed (`client.close()`) everywhere the handle's sandbox/session are
  disposed: creation-failure cleanup (`runner.ts:596-598`), closed-race
  cleanup (`:612-621`), eviction, `rejectSession`, runner close — each
  path spy-tested (§5).
- Tool list is fetched once per connection (no `listChanged`
  subscription in M1 — §8).

### 4.3 SSRF guard on control-plane dials

The transport takes a custom `fetch`. We supply one whose dialer resolves
the hostname once through `createPinnedLookup()` (`egress/ssrf.ts:93`) and
connects to the vetted address, preserving the hostname for TLS SNI — the
same no-TOCTOU property the egress proxy has. Concretely: a small
`undici.Agent` with `connect: {lookup: pinnedLookup}` passed as the
transport's `fetch` (undici added as an explicit dependency — Node's global
fetch is undici but doesn't expose dispatcher wiring). The shipped transport
`.d.ts` says `opts.fetch` is "used for all network requests"; §5 verifies
that empirically for **both** channels (POST RPC and GET SSE stream) — if
the SSE GET bypasses `opts.fetch`, that is a ship-blocker for the slice.

Tests must prove the **property**, not just a static block (§5): a
rebinding-simulation lookup (public IP at first resolution, blocked IP on
any re-resolution) must still connect only to the originally-pinned
address. Plus the standard mutation pair: guard on → loopback fixture
unreachable; test-only `allowAddress: () => true` seam (proxy.ts:108
precedent, wired through runner opts, never request input) → reachable.

Redirects: `requestInit.redirect = "error"` — a public URL 30x-ing to an
internal address is the classic guard bypass; MCP servers have no business
redirecting the RPC endpoint. §5 includes a 302 fixture asserting the SDK's
fetch path honors it.

### 4.4 Tool bridge (`sessions/pi/mcp/bridge.ts`, new) — modeled on the tool-permission path

Review finding (Opus #1/#2): everything this bridge needs —
`evaluated_permission`, id-bind-**before**-execute, `requires_action`
coalescing, the single inbound confirmation claim — lives in the
**tool-permission** machinery, not the custom-tool machinery. The
custom-tool bridge contributes only the `defineTool` registration shape and
content mapping. Concretely:

**Registration.** For each discovered tool that survives `mcp_toolset`
filtering (`default_config.enabled` default true, `configs[].enabled`
override by bare name, case-sensitive; a `configs[].name` that matches no
server-reported tool is **silently ignored** — consistent with "bare tool
name as reported by the server", locked by test): register
`defineTool({name: piName, parameters, execute, executionMode: "parallel"})`.

- **Pi-visible name** is `mcp__{server}__{tool}`. The prefix is a
  convention, not a guarantee: collisions are possible both with
  user-defined custom tools and between server/tool pairs
  (`a`+`b__c` vs `a__b`+`c`). Therefore session build **rejects on
  collision**: after assembling the full name set (sandbox + custom + MCP),
  any duplicate fails `ensureSession` with an explicit error naming both
  sources (extends `assertNoSandboxCustomToolNameCollision`,
  `runner.ts:580`). Events carry the bare `name` + `mcp_server_name`
  (§3.2) — wire parity is at the event layer. Model-visible naming stays
  probe-me-later (§9 open Q1).
- MCP pi-names are added to `handle.customToolNames` (Opus #9) — that one
  set already drives translator suppression (`translator.ts:61/:84`) and
  the collision assertion; no new `RuntimeTranslatorContext` field.
- **Schema:** MCP servers ship arbitrary JSON Schema; Pi's `parameters` is
  TypeBox-typed and the pass-through (`as never`, `custom-tools.ts:68`) is
  only proven for author-controlled schemas. Implementation probes a real
  third-party server's tool end-to-end through Pi **before** relying on
  pass-through; if a reported schema doesn't validate/execute cleanly, the
  bridge degrades that tool to a permissive object schema (accept any
  object, let the server do the validating — probe 46 shows servers reject
  bad args in-band with `isError`) rather than wedging registration.

**Execute sequence** (each step's failure path lands in the terminal-result
rule below):

1. Evaluate permission (`allow`/`ask`/`deny`) from the toolset config
   (default **`always_ask`** per upstream — an OMA agent with an MCP
   toolset and no `permission_policy` config pauses for confirmation on
   every MCP call, exactly like hosted).
2. Emit internal `oma.mcp_tool_use` handled **like `oma.tool_permission_use`**:
   extend the coalescing trigger (`runner.ts:371`) to fire for it, add an
   MCP-aware message-end matcher (the existing `takeMessageEndForToolCall`,
   `runner.ts:943`, matches sandbox-builtin toolCalls only — the MCP
   variant recognizes MCP `piToolCallId`s independent of sandbox), and add
   a `persistMcpToolUse(WithModelEnd)` pair mirroring
   `persistToolPermissionUseWithModelEnd` (`events/service.ts:1296-1314`,
   `:2012`). The `sevt_*` id is **bound before execution**
   (resolve-on-bind, `tool-permissions.ts:222-243` pattern) so the result
   event can reference it. Allow-path persists-and-continues; only the
   ask-path adds a pending confirmation (mirror `events/service.ts:1883-1885`).
3. Confirmation storage/claiming: **widen `PiToolPermissionBridge`**
   (Opus #2 option a — one confirmation authority) to accept MCP tools:
   its `SandboxedBuiltinToolName` typing and `access()` resolver gain an
   MCP-qualified variant; the inbound claim path
   (`events/service.ts:2329` → `runner.ts:192-202`) is unchanged. Deny (or
   deny-by-timeout) returns the deny message to the model as the tool
   error without executing.
4. `callTool({name: bareName, arguments, signal})` on the connection.
5. Emit internal `oma.mcp_tool_result` with `mcp_tool_use_id` = the bound
   `sevt_*` id, `content` mapped (text → text; anything else →
   JSON-stringified text block, the `toPiToolContent` precedent — richer
   block mapping deferred, §8), `is_error` from `isError`.
6. Return content to Pi (throw on `isError`, message from text content —
   same model-facing contract as `custom-tools.ts:188-190`).

**Terminal-result rule (Codex-adv #1):** every persisted
`agent.mcp_tool_use` gets exactly one `agent.mcp_tool_result`, on **every**
path: success; in-band `isError`; permission deny (synthesized result,
`is_error: true`, deny message as text); confirmation timeout; Pi abort;
call timeout; **transport-level rejection** (probe 46: in-band failures
never throw — a `callTool` rejection means the transport/protocol died;
synthesize the result with `is_error: true` AND mark the connection failed
so §4.6's connection-failure semantics engage). No orphaned use events.

**Output cap (Codex-adv #2):** the byte cap (default 400 KB, configurable)
applies **after normalizing every content block** — text and
JSON-stringified non-text alike — before both persistence and the
model-visible return, with an explicit `[truncated by oma: N bytes total]`
marker. Upstream's >100K-token spill-to-sandbox-file is a known deviation
(§3.1, §8) — truncation is honest and bounded.

### 4.5 Events & translator

- `types/events.ts`: add `"agent.mcp_tool_use"`, `"agent.mcp_tool_result"`
  to `EVENT_TYPES` + payload interfaces per §3.2. Both are emit-only
  (never client-sendable — the `events/service.ts` inbound allowlist at
  `:2779` is untouched).
- Translator suppression comes free via `handle.customToolNames` (§4.4);
  tests cover **both directions** — MCP calls never leak as generic
  `agent.tool_use`/`agent.tool_result`, and a user-defined custom tool
  whose name happens to start with `mcp__` is not wrongly suppressed
  (set-membership, not prefix-matching, is the mechanism).
- `docs/references/managed-agents-event-topology.md`: two rows Deferred →
  Implemented.
- Metrics (rides Arc C): `oma_mcp_tool_calls_total{outcome}`
  (`ok|error|denied|timeout`) and
  `oma_mcp_connections_total{event}` (`connected|connect_failed`) via the
  existing registry — closed label sets, registered in `instruments.ts`.

### 4.6 Failure semantics & retry

- Connect/discovery failure for server S: queue on the handle, flush at
  turn start (§4.2) as `session.error` with
  `{type: "mcp_connection_failed_error", mcp_server_name: S, message,
  retry_status: {type: "retrying"}}`; session proceeds without S's tools.
- **Retry on idle→running, fresh-handle mechanics** (review clusters
  B/Codex #3/Codex-adv #3/Opus #10 — live tool re-registration into a
  running Pi session is unproven SDK surface and is *not* attempted): a
  handle with failed servers is marked `closeWhenIdle`, so it is disposed
  when the turn ends and the **next** turn builds a fresh handle — which
  re-runs connect/discovery for all declared servers. Net behavior: every
  idle→running transition retries failed servers, satisfying the upstream
  contract with proven mechanics. Cost: sessions with a failed server
  don't keep a warm handle between turns; acceptable and documented.
- **Retry budget (OMA policy, §3.3):** the consecutive-failure count per
  (session, server) lives in a runner-level map keyed by session id
  (it must survive handle recreation — that is the mechanism). After N
  consecutive failures (default 5): `retry_status: {type: "exhausted"}`,
  stop dialing that server for the session's remaining lifetime. A success
  resets the counter. `terminal` is reserved (upstream uses it for
  session-terminating errors; no M1 path produces it).
- **Deployment gate:** MCP dialing is enabled by a deployment-config flag
  (`mcp: {enabled: boolean}`), **default off**, consistent with every other
  outbound-capability opt-in (sandbox providers, egress). Disabled + agent
  declares servers → session still starts, one
  `mcp_connection_failed_error` per server with `message: "MCP is disabled
  by deployment configuration"`, `retry_status: {type: "exhausted"}`, no
  dial attempted. Agent creation is **not** rejected (agents are portable
  configs). Upstream's *per-environment* `allow_mcp_servers` axis is a
  named parity gap (§3.1, §8) — OMA has no per-environment networking
  object to hang it on yet.

---

## 5. Testing (M1)

Fixture: in-process `@modelcontextprotocol/sdk` streamable-HTTP server on
loopback (stateful transport — §3.4 note), reached through the
`allowAddress` test seam. No network, no mocks of the protocol itself.
**E2E tests run against the real `createPiSession` + a fixture model — the
`sessionFactory` branch bypasses MCP wiring entirely and would green-light
nothing (§4.2).**

- **Validation matrix** (`agents/__tests__`): both-ways cross-check (each
  direction), `mcp_servers` non-empty with `tools` absent entirely,
  duplicate names, duplicate toolsets per server (labeled OMA tightening),
  case-sensitivity locks (server-name uniqueness, cross-check equality),
  21 servers, 256-char name, 2049-char URL, `ftp://` scheme, embedded
  userinfo (`https://user:pass@host/`) rejected, unknown server fields,
  **URL round-trip byte-equality** (redundant default port, mixed-case
  host, trailing slash — stored exactly as sent).
- **Bridge e2e** (`pi/__tests__`): agent with MCP toolset → session → model
  fixture calls tool → assert persisted `agent.mcp_tool_use` (bare name,
  `mcp_server_name`, `evaluated_permission`) then `agent.mcp_tool_result`
  (`mcp_tool_use_id` = the use event's id, content, `is_error`) — and that
  **no** generic `agent.tool_use`/`agent.tool_result` was emitted for the
  call (translator suppression, one test per direction) — and the
  **false-positive direction**: a custom tool named `mcp__like__this` still
  emits its normal events.
- **Terminal-result matrix (Codex-adv #1):** one test per path asserting
  every `agent.mcp_tool_use` gets its `agent.mcp_tool_result` — success,
  in-band `isError`, permission deny (deny message in content,
  `is_error: true`, fixture asserts zero server hits), confirmation
  timeout, abort, **mid-call transport failure** (fixture killed between
  `listTools` and `callTool` — distinct from in-band; probe 46 proves
  in-band never throws) with the connection then marked failed.
- **Permission flow**: default (no `permission_policy`) pauses with
  `requires_action`; `user.tool_confirmation` allow → executes; deny → per
  terminal-result matrix; `configs[].enabled: false` tool absent from Pi's
  surface; **two parallel `ask` calls get distinct `sevt_*` binds and
  independent confirmations** (Opus #6).
- **Filtering**: `default_config.enabled false` + explicit allowlist
  enables exactly the listed tools; a `configs[].name` matching no
  server-reported tool is silently ignored (locked).
- **Failure semantics**: unreachable URL → session starts, error event with
  `retrying` **flushed at turn start**; disabled deployment flag →
  `exhausted` + zero dials; retry driven by **real idle→running
  transitions** (not an internal function call — Sonnet #7): first connect
  fails, server comes up, next turn's fresh handle connects and the tool is
  callable; N consecutive failures across N transitions → `exhausted`,
  no further dials; success resets the counter.
- **Disposal (Sonnet #6):** spy-based test per cleanup path
  (creation-failure, closed-race, eviction, `rejectSession`, runner close)
  asserting `client.close()` fires exactly once; in-flight `callTool`
  rejected by close surfaces as a tool error + terminal result, not an
  unhandled rejection.
- **SSRF property pair (§4.3):** (a) mutation pair — guard on → loopback
  fixture unreachable (`mcp_connection_failed_error`); `allowAddress` seam
  → reachable; (b) **rebinding simulation** — lookup returns a public
  (fixture-reachable via seam) address first, a blocked address on any
  re-resolution; connection must go to the pinned first address only;
  (c) both channels — assert the guard applies to the GET SSE stream, not
  just the POST (if the SDK's `opts.fetch` doesn't cover GET, ship-block);
  (d) 302 fixture → connect failure, redirect not followed.
- **Output cap**: oversized **text** result and oversized
  **non-text block** (JSON-stringified image/resource) both truncated with
  marker in event + model result (Codex-adv #2).
- **Collision rejection:** custom tool named `mcp__srv__tool` colliding
  with server `srv` tool `tool` → session build fails with an error naming
  both; ambiguous pair (`a`+`b__c` vs `a__b`+`c`) → same.
- **Live hosted probe** (separate scratch, before merge, pattern of probe
  32): create a hosted agent with a public MCP server, capture real
  `agent.mcp_tool_use`/`mcp_tool_result` frames, diff against our fixtures;
  also revisits the duplicate-toolset tightening (§4.1) and open Q1. If no
  API access at implementation time, ship gated on SDK-types parity and
  file the probe as a follow-up issue (0015-0038's "don't fake it" rule: no
  claimed hosted parity without the probe).

Suite discipline: `pkill -f vitest` first, foreground
`npx vitest run --no-file-parallelism` with output redirected to scratch.

---

## 6. Docs (M1)

- `docs/dev-deployment.md`: "MCP servers" section — deployment flag,
  streamable-HTTP-only support statement, SSRF posture (what will refuse to
  connect and why), permission default (`always_ask`), failure/retry
  semantics (incl. the fresh-handle retry cost), output-cap deviation,
  wrap-stdio-servers-with-a-shim pointer.
- `docs/threat-model.md`: new row/paragraph — control-plane outbound dials
  to agent-declared URLs are a new egress class, mitigated by pinned-lookup
  deny + redirect refusal + userinfo rejection + deployment gate;
  credentials story unchanged until M2 (then: injected control-plane-side,
  never sandbox-visible).
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
  credential resolution by **byte-exact URL match** (M1 persists raw
  strings precisely for this, §4.1); injection via the transport's
  `requestInit` Authorization header — control-plane-side only.
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
- **Per-environment `allow_mcp_servers` gate** (§3.1) — upstream gates MCP
  per environment under `limited` networking; OMA has no per-environment
  networking object. Deployment-wide flag in M1; named parity gap to
  revisit when environments grow a networking config.
- **>100K-token spill-to-sandbox-file** — M1 truncates with a marker
  (§4.4); the file-spill needs sandbox-write plumbing that pulls the slice
  off its critical path.
- **Rich content-block mapping** (image/document/search_result from MCP
  results) — text + stringify fallback in M1 (capped, §4.4).
- **`listChanged` tool-list subscriptions**, MCP resources/prompts/sampling
  — tools only, list fetched at connect.
- **Live tool re-registration into a running Pi session** — unproven SDK
  surface; retry uses fresh-handle mechanics (§4.6).
- **Console UI for MCP servers** — the "MCPs and tools" section gets real
  rendering in a later console polish slice.
- **Env-var (`environment_variable`) vault credentials** — egress-proxy
  placeholder substitution; separate slice after M2 if wanted (the hosted
  platform doesn't support it on self-hosted sandboxes either).

---

## 9. Review log & open questions

**Pre-implementation review, 2026-07-06** — Codex (review + adversarial),
Opus, Sonnet against `b1057c2`. 24 findings, 0 refuted, deduplicated to 10
clusters, all folded:

| Cluster | Findings | Disposition |
|---|---|---|
| A — event-plumbing template | Opus 1+2 (HIGH), Codex 2 (P2), Codex-adv 1 (HIGH) | §2/§4.2/§4.4 rewritten: tool-permission bridge is the template (id-bind-before-execute, coalescing trigger + MCP-aware message-end matcher, widened `PiToolPermissionBridge` as single confirmation authority); connection failures queue on the handle and flush at turn start (`emitInternal` doesn't exist at build time); terminal-result rule guarantees a `mcp_tool_result` on every path incl. deny. |
| B — retry honesty | Codex 3, Codex-adv 3, Opus 10, Sonnet 9 | §4.6 rewritten: fresh-handle-via-`closeWhenIdle` implements the idle→running retry contract with proven mechanics; live re-registration moved to non-goals; failure counter survives handle recreation; 5-failure budget labeled OMA policy (§3.3). Old open Q3 resolved. |
| C — output cap coverage | Codex-adv 2 (HIGH) | §4.4: cap applies after normalizing every content block; oversized non-text fixture added (§5). |
| D — tool-name collisions | Codex 1, Opus 9 | §4.4: `mcp__` prefix is convention not guarantee — explicit collision rejection at session build (incl. the `a`+`b__c` ambiguity); MCP names fold into `handle.customToolNames` (suppression + collision assertion for free). |
| E — SSRF depth | Opus 8, Sonnet 4 | §4.3/§5: guard must cover POST + GET SSE channels (ship-blocker if `opts.fetch` doesn't); rebinding-simulation property test added; 302 fixture added. |
| F — URL normalization | Sonnet 1 (HIGH) | §4.1: raw input string persisted, `new URL` check-only; byte-equality round-trip test. Upstream's own trailing-slash warning cited (§3.1). |
| G — schema assignability | Opus 4 | §4.4: probe a real third-party tool through Pi before relying on pass-through; permissive-object-schema fallback so a hostile schema can't wedge registration. |
| H — concurrency/abort/disposal/error classes | Opus 6+7, Sonnet 5+6 | §4.2/§4.4/§5: JSON-RPC multiplexing verified before reliance, `executionMode: "parallel"`, parallel-ask test; Pi signal threaded to `callTool`; close-rejection = tool error + terminal result; disposal spy-tests on all five cleanup paths; in-band `isError` vs transport-rejection split (probe 46 committed as evidence) with distinct fixtures. |
| I — parity-ledger hygiene | Sonnet 2+3+10, Opus 5 | §3.1: spill-to-file and per-environment `allow_mcp_servers` added to the ledger as named deviations/gaps (§8); duplicate-toolset rule relabeled OMA tightening pending probe; probe committed as `scratch/46-mcp-sdk-client-probe.{mjs,md}` with pinned versions. |
| J — test-rigor smalls | Sonnet 7+8+11, Opus 3 | §4.1/§5: retry tests drive real idle→running transitions; false-positive suppression test; case-sensitivity locks; embedded-userinfo URLs rejected; absent-`tools`-field case explicit; `configs[].name` typo = silently-ignored, locked by test; e2e must use real `createPiSession` (sessionFactory bypass warning). |

**M1 implementation review, 2026-07-07** — Codex (review + adversarial),
Opus, Sonnet against the full branch diff. 19 findings → 8 clusters, all
applied; none refuted:

| Cluster | Findings | Disposition |
|---|---|---|
| A — discovery hardening | Codex 1, Codex-adv HIGH | client.ts: tools/list pagination cursors followed (page-capped); bounds on tool count (256), name (256), description (4KB), schema bytes (64KB) — exceed → structured connection failure. Bounds tests added; note: the in-process fixture serves one page, so the cursor loop is bounded-by-review + MAX_TOOL_LIST_PAGES, not multi-page-fixture-tested. |
| B — parallel dials | Codex 2, Opus HIGH | prepareMcp dials via Promise.all with declaration-order outcome processing; N slow servers no longer serialize to N×timeout while pinning the sandbox. |
| C — mid-call transport semantics | Opus MED, Codex-adv MED, Sonnet 6 | Abort (user interrupt) no longer classified as transport failure (no handle teardown, outcome label `aborted`, asserted); real transport failures now count against the retry budget and emit `mcp_connection_failed_error` once per server per handle. Mid-call-failure e2e through a real model turn remains live-probe territory (closure covered at the bridge boundary). |
| D — real-runner gaps | Sonnet HIGH 1-3 | Flush-at-turn-start now driven through the REAL runOnSession (abort-after-observation keeps it hermetic vs ambient credentials); coalescing matcher exported + contract-tested (splice, consumed-fallback, set-membership); ambiguous cross-server pair (`a`+`b__c` vs `a__b`+`c`) rejection tested. |
| E — SSRF hostname path | Opus LOW, Sonnet MED | `localhost` (hostname, not literal) cases force the undici pinned-lookup dispatcher: blocked, seam-reachable, per-resolution re-consult. |
| F — session_thread_id | Sonnet MED | Emitted (`null`) on agent.mcp_tool_use per probe 47; asserted in e2e. |
| G — test flakiness | Sonnet MED | Fixture bind-retry on EADDRINUSE for fixed-port recovery test; `closeAllConnections` in fixture teardown (also removed a latent 47s hang from kept-alive sockets). |
| H — smalls | Sonnet 8-11, Opus LOW-4 | configs-typo resolver test; probe-doc + dev-deployment note that `mcp_connection_failed_error` is SDK-types-verified only (no live failure frame captured); teardown-orphan caveat comment at emitResult; plan create-only wording fixed. |

Accepted as-is: Opus LOW-5 (cap approximations — commented), LOW-6
(redundant early turn-state). Opus endorsed keeping the deliberate
publish/persist duplication until after M2 and confirmed M2 readiness
(byte-exact URLs at the store layer, clean requestInit seam).

**Open questions (for the live hosted probe / implementation):**

1. **Model-visible tool naming** — `mcp__{server}__{tool}` with
   collision-rejection is the M1 design; what hosted shows the model is
   not observable on the wire (live probe 47 confirmed events carry only
   the bare name + `mcp_server_name`). Our call stands; wire parity
   unaffected.

**Live probe 47 (2026-07-07, `scratch/47-mcp-hosted-probe.{py,md}`):** all
M1 wire shapes confirmed against hosted (allow + ask flows, requires_action
`event_ids`, `user.tool_confirmation` round-trip, bare names,
`mcp_tool_use_id` correlation). Validation: dangling-toolset, unreferenced-
server, and duplicate-toolset rejections are hosted parity; userinfo-URL
rejection is an OMA deviation (hosted accepts). §5's "no claimed hosted
parity without the probe" condition is satisfied.
2. **Deployment gate default off** (§4.6) — parity purists could argue MCP
   should work out of the box like hosted; the opt-in posture matches every
   other outbound capability in the appliance. No reviewer objected;
   standing decision unless the user overrides.
