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
  `mcp_authentication_failed_error`. Closes the exit criterion. **Full spec:
  §7A (amendment, 2026-07-08).**
- **M3** — `mcp_oauth` credential type + refresh worker +
  `mcp_oauth_validate`. **Full spec: §7B (amendment, 2026-07-09).**

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

- **M2 — vaults + `static_bearer`.** ~~Sketch~~ — **superseded by the full
  amendment in §7A (2026-07-08).**
- **M3 — `mcp_oauth` + refresh.** ~~Sketch~~ — **superseded by the full
  amendment in §7B (2026-07-09).**

---

## 7A. M2 plan amendment (2026-07-08): vaults + `static_bearer`

Amends the §7 M2 sketch into a full slice spec. `file:line` against `main`
at `a6d2ffc` (M1 merged); the #160 `events/service.ts` split is in flight —
M2 touches the MCP persistence path, so **M2 implementation starts only
after #160 lands** and line references there must be re-confirmed.

### 7A.1 Definition of done (M2)

Closes the roadmap exit criterion: *"an agent in a workspace can use one MCP
server whose credentials it cannot read."* Concretely:

- `/v1/vaults` + nested `/credentials` CRUD, workspace-scoped, wire-shaped
  per upstream (§7A.2). `static_bearer` only; `mcp_oauth` and
  `environment_variable` credential types are rejected with the standard
  not-yet-supported error (M3 / non-goal §8).
- `sessions.create` accepts `vault_ids` (drop the `service.ts:961`
  rejection), validates and persists them, echoes them on the session
  record.
- Connect-time credential resolution by **byte-exact URL match** (M1
  persists raw URL strings precisely for this, §4.1), first-vault-wins,
  unauthenticated fallback when nothing matches — all upstream-documented
  runtime behavior.
- Injection as an `Authorization: Bearer` header on every transport request
  (POST and GET/SSE), control-plane-side only. The token never reaches the
  sandbox, the event stream, the session handle, or the logs.
- `mcp_authentication_failed_error` on MCP 401/403 from a reached server,
  same
  `session.error` + `retry_status` envelope as `mcp_connection_failed_error`.
- **Exit-criterion test**: a live/e2e session calls a bearer-protected MCP
  fixture successfully, and a sweep proves the token appears nowhere in the
  sandbox, persisted events, or captured logs (0121 redaction chokepoint
  covers the log leg).

### 7A.2 Wire contract (evidence: vaults.md + mcp-connector.md crawls 2026-07-06; api-reference 2026-07-08)

**Endpoints** (all under the workspace API key, like agents/sessions):

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/vaults` | create |
| GET | `/v1/vaults` | list, `page`/`next_page`, newest first, `include_archived=true` opt-in |
| GET | `/v1/vaults/{vault_id}` | retrieve |
| POST | `/v1/vaults/{vault_id}` | update (`display_name`, `metadata`) |
| DELETE | `/v1/vaults/{vault_id}` | hard delete, no record retained |
| POST | `/v1/vaults/{vault_id}/archive` | cascades to credentials; secrets purged, records retained |
| POST | `/v1/vaults/{vault_id}/credentials` | create |
| GET | `/v1/vaults/{vault_id}/credentials` | list (same pagination) |
| GET | `/v1/vaults/{vault_id}/credentials/{credential_id}` | retrieve (metadata only) |
| POST | `/v1/vaults/{vault_id}/credentials/{credential_id}` | update (rotate token, `display_name`) |
| DELETE | `/v1/vaults/{vault_id}/credentials/{credential_id}` | hard delete |
| POST | `/v1/vaults/{vault_id}/credentials/{credential_id}/archive` | purges secret; key freed for a replacement |
| POST | `.../mcp_oauth_validate` | **M3** — 404/not-supported in M2 |

**Records.** Vault: `{type: "vault", id: "vlt_…", display_name, metadata,
created_at, updated_at, archived_at}` (docs show a literal create/response
pair). Credential: id prefix `vcrd_` (seen in the validation object);
response carries `display_name`, timestamps, `archived_at`, and an `auth`
block **without secret fields** — `token` (and M3's `access_token`/
`refresh_token`/`client_secret`) are write-only, never returned. The exact
credential-response field set is not shown in the docs → **probe 50**
captures it before implementation; until then the store models
`{type: "static_bearer", mcp_server_url}` as the readable auth subset.

**Constraints (upstream-documented):**

- `mcp_server_url` unique among **active** credentials in a vault; duplicate
  → 409. Archived credentials free their key for a replacement.
- Structural fields immutable after create (`mcp_server_url`; M3:
  `token_endpoint`, `client_id`) → archive-and-recreate.
- Max 20 credentials per vault.
- Credentials are **not validated at write time** — an invalid token
  surfaces at session runtime as the error event, never blocks the session.
- Vaults/credentials are workspace-scoped; any key in the workspace can
  reference them (revocation = archive/delete).

**Runtime behavior (upstream-documented, mcp-connector.md §368-379):**

- Credential matched by exact `mcp_server_url` == declared server `url`;
  upstream's own docs warn trailing-slash variants don't match.
- No match → connect unauthenticated (may then 401 like any M1 connect).
- Multiple vaults matching → **first vault in `vault_ids` order wins**.
- `mcp_authentication_failed_error` = "server reached but rejected the
  credential from the attached vault"; `mcp_connection_failed_error` stays
  the transport/network class. Same envelope (`mcp_server_name`,
  `retry_status`), same retry-on-idle→running semantics.
- Rotation propagates to running sessions without restart upstream
  ("re-resolved periodically"). **OMA approximation**: resolution happens at
  connect time, and M1's fresh-handle mechanics (§4.6) rebuild connections
  on every idle→running transition and after failures — so rotation
  propagates at the next handle build, not mid-turn. Named deviation;
  periodic mid-session re-resolution lands with M3's refresh worker.

### 7A.3 Design

**Storage.** New `vaults` + `vault_credentials` tables (metadata,
workspace-scoped, `archived_at` soft state) in a new
`src/control-plane/vaults/` module following the house layout
(`types/store/service/routes` — mirror `secrets/` + `agents/`). Token
values go in the existing `SecretsStore` (0118, ADR 0016) under a
**reserved synthetic name** `vault/{vault_id}/{credential_id}`:

- One sealing path, one master-key-rotation path (`rotateMasterKey` covers
  vault tokens for free), `reveal()` stays the single loud plaintext seam.
- The user-facing `/v1/secrets` surface (OMA-specific, not wire parity)
  must not own these rows: `create` and `delete` reject names starting with
  the reserved `vault/` prefix, and `list` filters the prefix out. (Names
  are currently unconstrained beyond length — reserving the prefix is a
  narrow, documented break.)
- Archive/delete of a credential deletes the `SecretsStore` row (purge);
  vault archive cascades. Metadata rows survive archive, vanish on delete.
- **Atomic writes (review 7A-2, corrected round 2).** Durable deployment
  already hands `SqliteSecretsStore` the SAME `DatabaseSync` as every
  other store (`deployment-storage.ts:189`); the limitation is only that
  the portable `SecretsStore` interface exposes no transaction seam. And
  `withSqliteTransaction` is savepoint-based, so it **nests** — an outer
  transaction wrapping `secrets.put`/`delete` (which open their own
  savepoints) is safe. So M2 does the cheap, correct thing: the vault
  store is constructed with the same `DatabaseSync` as the secrets store
  (memory-mode wiring shares one `:memory:` handle between the two), and
  every credential create/rotate/archive/delete wraps its metadata write
  plus the `SecretsStore` call in one outer `withSqliteTransaction` —
  metadata and secret commit or roll back together; no orphans in either
  direction. The **fail-toward-less-retention ordering** (seal-then-
  metadata on create, purge-then-metadata on archive; purge retry
  idempotent since `SecretsStore.delete` of a missing name returns
  `false`) is kept as the invariant *inside* the transaction and the
  fallback for any future wiring that doesn't share a handle — but the
  plan no longer treats separate handles as the premise.
- **No master key → no credential writes (review 7A-3).** `SecretsStore`
  is `undefined` without `OMA_MASTER_KEY` and credential create/rotate
  must fail loudly with the same wire-shaped `invalid_request` the
  `/v1/secrets` surface returns today (`secrets/service.ts:50`
  `requireStore` message), never half-create metadata (the create ordering
  above guarantees this: the secret write is first and it is the failing
  step). Vault CRUD and credential list/retrieve/archive/delete remain
  available — they are metadata-only.
- **Reserved-prefix compatibility (review 7A-5; implementation review
  tightened).** Any pre-existing user-created secret named `vault/…` (none
  known; the surface shipped 2026-07-06) disappears from `list` and cannot
  be created or deleted through `/v1/secrets`. The vault lifecycle is the
  sole owner of that namespace; keeping generic delete open would let a
  workspace caller remove a live vault credential's backing token via
  encoded slash params.

**Routes & auth gate (review 7A-4).** `vaultsRoutes` mounts under
`/v1/vaults` in `app.ts` AND the path must be registered in the
managed-route auth prefix list — the known footgun from `/v1/secrets` is a
mounted route missing from the gate silently binding to `wrk_default`.
Locked by tests, not convention: unauthenticated requests to every
`/v1/vaults*` route → 401; workspace A retrieving workspace B's vault or
credential by guessed id → 404 (not 403 — no existence oracle).

**Session create.** Drop `rejectUnsupportedField(obj, "vault_ids")`
(`sessions/service.ts:961`), parse as an array of `vlt_` ids (each must
exist in the workspace and be unarchived at create time — archived vault →
4xx, matching upstream's "future sessions referencing this vault fail").
Persist as a JSON column on `sessions` (schema bump), echo on the wire.
Order is semantic (first-vault-wins) and must round-trip byte-stable.
Upstream cap per session is undocumented → probe 50; until evidence, cap at
20 with a loud comment (same posture as M1's server cap).

**Credential resolution seam.** New optional `credentials?:
McpCredentialResolver` on `PiMcpOptions` (`runner.ts:99`):

```
type McpCredentialResolver = (
  workspaceId, sessionId, serverUrl: string,
) => { token: string } | undefined;
```

`prepareMcp` calls it per dialable server immediately before
`McpConnection.connect` and hands the token straight into the transport —
never stored on the handle, never in a declaration object that might get
logged. Store-backed impl in `app.ts` (next to
`createStoreBackedMcpServersProvider`): session row → `vault_ids` in
order → first active credential with `mcp_server_url === serverUrl`
(byte-exact) → `SecretsStore.reveal`. Absent resolver or no match =
unauthenticated connect (M1 behavior unchanged). Vault CRUD is **not**
gated by `OMA_ENABLE_MCP` (storage is inert); only injection is, by
geometry — no MCP dials happen when the gate is off.

**Injection.** `McpConnection.connect` gains `authorization?: string`;
passes `requestInit: { headers: { Authorization: "Bearer …" } }` to
`StreamableHTTPClientTransport`. **Probe 49 passed** (2026-07-08,
`scratch/49-mcp-auth-sdk-probe.{mjs,md}`): at SDK 1.29.0,
`requestInit.headers.authorization` reaches both POST and GET/SSE request
legs, so no guarded-fetch wrapper is needed for M2.

**Auth-failure classification.** Connect rejections carry the HTTP status
(SDK `StreamableHTTPError.code` — probe 49 confirms). Classification rule,
updated by **probe 50** (2026-07-08): MCP server 401/403 after a reached
HTTP endpoint → `mcp_authentication_failed_error`, **whether or not a vault
credential was injected**. Hosted emitted the auth class for both a bogus
`static_bearer` credential and a no-`vault_ids` Linear MCP session; reserve
`mcp_connection_failed_error` for network/timeout/non-auth HTTP failures.
Plumbing: the failure path §4.6 already built gains an error-type parameter —
`persistMcpConnectionFailed` (events service; post-#160 location) takes
`type: "mcp_connection_failed_error" | "mcp_authentication_failed_error"`,
and `ManagedAgentsMcpAuthenticationFailedError` joins `types/events.ts`
(same shape, different discriminator). Auth failures share the M1
consecutive-failure budget — deliberate, prevents hammering a server that
keeps saying 403 — **but the budget must not outlive the credential that
earned it** (review 7A-1, 2026-07-08): M1's exhausted state suppresses all
further dials for the session, so a bad token would exhaust the budget and
a subsequent rotation would never be retried. Fix: the
`mcpFailureCounts` entry records the **resolved-credential fingerprint**
(`credential_id` + `updated_at`; `"none"` when unauthenticated) used on the
last failed dial; when `prepareMcp` resolves a different fingerprint for
that server — token rotated, credential added after exhaustion, vault
attached — the count resets and dialing resumes. Fingerprint comparison
uses metadata only; the token value never enters the key.

**Redaction.** The revealed token exists transiently in `prepareMcp` stack
frames and the transport's header map. Register it with the 0121 logger
redaction registry for the dial's duration (same pattern as egress secret
injection), and never place it on the handle, an event payload, or an error
message — the auth-failure event carries the server name and status class,
not the header. Test asserts the token string is absent from every
persisted event and captured log line.

**Metrics.** `oma_mcp_connections_total` gains outcome `auth_failed`
(alongside `connected`/`connect_failed`); `instruments.ts` + the `app.ts`
hook extend accordingly. No new instrument.

**IDs.** `newVaultId` (`vlt_`), `newVaultCredentialId` (`vcrd_`) in
`ids.ts`, UUIDv7 like the rest.

### 7A.4 Probes (before implementation, same discipline as 46/47)

- **Probe 49 (SDK, hermetic)** — DONE 2026-07-08
  (`scratch/49-mcp-auth-sdk-probe.{mjs,md}`): `requestInit.headers` reaches
  POST and GET/SSE at SDK 1.29.0; credentialed 401/403 reject as
  `StreamableHTTPError` with `.code`.
- **Probe 50 (hosted, live)** — DONE 2026-07-08
  (`scratch/50-vaults-hosted-probe.{py,md}`): captured vault + credential
  CRUD shapes, duplicate/immutability/archive behavior, write-only secret
  fields, session `vault_ids` echo, raw pagination optionality, and live
  `mcp_authentication_failed_error` frames for both bogus static-bearer and
  no-vault unauthenticated Linear MCP sessions.

### 7A.5 Testing (M2)

- **Vault CRUD matrix** (`vaults/__tests__/`): create/retrieve/update/list
  round-trips; 409 on duplicate active `mcp_server_url`; archived
  credential frees the key; structural-field update rejected; max-20
  enforced; `include_archived` filter; write-only fields never in any
  response (assert on serialized JSON, not the object); cross-workspace
  invisibility; hard delete vs archive record retention; archive purges
  the `SecretsStore` row (assert `reveal` → undefined).
- **Secrets-surface guard**: `/v1/secrets` create/delete rejects `vault/`
  prefix; list excludes vault-backed rows; `rotateMasterKey` rewraps vault
  tokens (rotate, then `reveal` still round-trips).
- **Atomicity + master-key**: credential create with an injected
  metadata-write failure rolls back the secret row too (no orphan —
  `reveal` → undefined after the failure); archive with an injected
  failure rolls back both, and the retry succeeds (purge idempotent);
  these atomicity tests run against the memory-mode wiring, which makes
  them double as the guard that vault + secrets stores share one handle
  there — separately-constructed `:memory:` stores would fail them;
  with no master key, credential create/rotate return the `requireStore`
  wire-shaped error and write nothing, while vault CRUD and credential
  metadata reads/archive still work.
- **Auth gate**: unauthenticated request to each `/v1/vaults*` route → 401
  (locks the prefix-list registration); cross-workspace guessed-id → 404.
- **Session create**: `vault_ids` accepted/persisted/echoed order-stable;
  unknown vault 4xx; archived vault 4xx; cross-workspace vault invisible
  (404-equivalent, not 403 — no existence oracle); cap enforced.
- **Resolution unit tests**: byte-exact match (trailing-slash mismatch →
  no match → unauthenticated), first-vault-wins across two matching
  vaults, archived credential skipped, no-vault sessions unchanged.
- **Injection e2e** (fixture grows a `requireBearer` option returning 401
  + `WWW-Authenticate` on mismatch): correct token → tools discovered and
  callable, Authorization asserted on every SDK-issued HTTP request
  server-side (the fixture rejects any missing token; POST is observed);
  wrong
  token → `mcp_authentication_failed_error` persisted with `retry_status`,
  no-vault 401/403 from the same auth-requiring server also →
  `mcp_authentication_failed_error` (probe 50), budget counts, exhausted
  after 5; rotation mid-session → next
  idle→running handle build connects with the new token; **rotation after
  exhaustion** → fingerprint change resets the count and the server dials
  again (locks review 7A-1 — without the reset this scenario never
  reconnects).
- **Secret-never-leaks** (the exit criterion): hermetic sweep asserting the
  token string absent from all persisted events, runner-emitted payloads,
  and captured log output; live smoke (probe-51-style, extending
  `scratch/48`) re-verifies against a real model turn with sandbox-side
  grep.
- **Classification**: unauthenticated 401/403 from an auth-requiring MCP
  server produces `mcp_authentication_failed_error` (locks the probe-50
  disposition).

### 7A.6 Docs (M2)

- `dev-deployment.md`: vaults section (create vault → credential →
  `vault_ids` walkthrough; `static_bearer`-only note; reserved `vault/`
  secret-name prefix).
- `threat-model.md`: credential storage (envelope under `SecretsStore`) and
  the injection boundary (control-plane dial, never sandbox) — extends the
  §3 control-plane-dials class from M1.
- Parity ledger (§8 updates): `mcp_oauth` + `mcp_oauth_validate` → M3;
  `environment_variable` credentials already listed; **vault/credential
  webhooks** (`vault.archived`, `vault_credential.*`) — OMA has no webhook
  surface at all; named gap, not an M2 item. Periodic mid-session
  re-resolution → named deviation until M3.
- Roadmap 0114: mark the third exit criterion's MCP half done on merge.

### 7A.7 M2 non-goals (beyond §8)

- `mcp_oauth`, refresh worker, `mcp_oauth_validate` — M3.
- Vault/credential webhooks — no webhook surface exists; parity-ledger gap.
- Periodic mid-session credential re-resolution — M3 (rides the refresh
  worker); M2 propagates rotation at handle-rebuild boundaries.
- `sessions.update` of `vault_ids` — no session-update surface (§8).
- Console UI for vaults — later console slice, with MCP servers (§8).

### 7A.8 Probe-closed questions

1. Credential GET/list response `auth` field set — probe 50: static bearer
   returns exactly `{type, mcp_server_url}`; no secret fields.
2. Per-session `vault_ids` echo — probe 50: create response includes
   order-stable `vault_ids`. Cap was not falsified; keep interim cap 20,
   matching the per-vault credential cap and M1 server cap.
3. Unauthenticated-401 classification — probe 50: hosted still emits
   `mcp_authentication_failed_error` for an auth-requiring MCP server when
   no vault credential is attached.
4. Vault metadata constraints — SDK/API reference and docs agree with
   agents/sessions: max 16 pairs, keys up to 64 chars, values up to 512
   chars; reuse the existing metadata validator.
5. Raw pagination shape — probe 50: list responses include `next_page` only
   when another page exists; terminal one-page responses omit it rather than
   returning `null`.

---

## 7B. M3 plan amendment (2026-07-09): `mcp_oauth` + refresh + `mcp_oauth_validate`

Amends the §7 M3 sketch into a full slice spec. `file:line` against `main`
at `40917ed` (M2 merged as `cf8cc4f`). Design decided with the user
2026-07-09: OAuth-server support is practically required (Linear, Slack,
Notion ship OAuth-first MCP servers), and the appliance constraint is
binding — one `npm run` / one `docker compose`, no new processes, no queue
infrastructure, no k8s.

### 7B.1 Definition of done (M3)

- Credential type `mcp_oauth` accepted on vault credential create/update
  (wire shapes §7B.2), with `access_token`/`refresh_token`/`client_secret`
  write-only and `mcp_server_url`/`token_endpoint`/`client_id` structurally
  immutable (archive-and-recreate).
- An agent session dials an OAuth-protected MCP server with a stored
  access token; when the token expires — **including mid-turn on a warm
  connection** (round 1: the call-time provider) and **including early
  revocation the clock cannot see** (round 2: 401-hint + one-shot retry
  of the failed request after a successful forced refresh — safe because
  auth rejection precedes tool execution) — OMA refreshes via the stored
  `refresh` block and the session keeps working **without a restart,
  without a reconnect, without a user-visible failed call, and without
  operator action** — proven by a live-style smoke against a hermetic
  OAuth token-endpoint + bearer-checking MCP fixture pair. Named residual
  (§7B.3): a process crash inside the milliseconds between the provider
  rotating a refresh token and OMA's persist can burn the grant —
  surfaces as `invalid`, recovers via consumer re-auth.
- `POST /v1/vaults/{v}/credentials/{c}/mcp_oauth_validate` returns the
  `vault_credential_validation` object with `valid|invalid|unknown`
  semantics.
- Zero new deployment surface: no new process, no new required env vars,
  the refresh loop lives in the existing control-plane process and the DB
  remains the only state.
- **No OAuth authorization flow, ever** (standing §8 non-goal): the API
  consumer runs the dance and stores the resulting tokens; OMA stores,
  injects, refreshes.

### 7B.2 Wire contract (evidence: vaults.md crawl 2026-07-06 + SDK types; probe 52 to close the response subset)

**Credential create (`auth.type: "mcp_oauth"`):**

```json
{
  "display_name": "Alice's Slack",
  "auth": {
    "type": "mcp_oauth",
    "mcp_server_url": "https://mcp.slack.com/mcp",
    "access_token": "xoxp-…",
    "expires_at": "2099-12-31T23:59:59Z",
    "refresh": {
      "token_endpoint": "https://slack.com/api/oauth.v2.access",
      "client_id": "1234…",
      "scope": "channels:read chat:write",
      "refresh_token": "xoxe-1-…",
      "token_endpoint_auth": {"type": "client_secret_post", "client_secret": "…"}
    }
  }
}
```

- `token_endpoint_auth.type`: `none` | `client_secret_basic` |
  `client_secret_post` (docs-enumerated).
- `refresh` optional — without it the credential is a fixed OAuth access
  token that simply starts failing at expiry (auth-failed events; `validate`
  reports `no_refresh_token`).
- **Update/rotate** merges: docs show `auth: {type, access_token,
  expires_at, refresh: {refresh_token}}` rotating tokens while leaving
  `token_endpoint`/`client_id`/`scope` untouched. Structural fields in an
  update → 400 (M2 precedent, hosted-probed for `mcp_server_url`).
- **Readable response subset** for `auth` is NOT probed (probe 50 covered
  static_bearer only). Expected: `{type, mcp_server_url, expires_at,
  refresh: {token_endpoint, client_id, scope, token_endpoint_auth: {type}}}`
  minus all secret fields — **probe 52 captures the exact key set** before
  implementation; write-only enforcement asserts on serialized JSON as in
  M2.

**`mcp_oauth_validate`** (docs `vaults.md:1080-1104`, literal response):

```json
{
  "type": "vault_credential_validation",
  "credential_id": "vcrd_…", "vault_id": "vlt_…",
  "validated_at": "…", "has_refresh_token": false,
  "status": "invalid",
  "mcp_probe": {"method": "initialize",
    "http_response": {"status_code": 401, "content_type": "…",
      "body": "…", "body_truncated": false}},
  "refresh": {"status": "no_refresh_token", "http_response": null}
}
```

Status semantics (docs): `valid` = token works, no action; `invalid` =
grant gone / OAuth server rejected refresh with 4xx → re-authorize;
`unknown` = transient (5xx/429/network) → retry later. The endpoint applies
to `mcp_oauth` credentials; behavior when called on a `static_bearer`
credential is unprobed → probe 52 (expected 400).

**Refresh grant itself** (standard RFC 6749 §6, hand-rolled — see §7B.3
buy-vs-build): `POST token_endpoint` form-encoded. The COMMON body is
`grant_type=refresh_token&refresh_token=…[&scope=…]`; client
authentication then adds, PER MODE and never combined (review round 2,
independent P2 — the earlier draft of this paragraph contradicted §7B.3):
`none` → `client_id` in the body; `client_secret_post` → `client_id` +
`client_secret` in the body; `client_secret_basic` → `Authorization:
Basic base64(urlencode(client_id):urlencode(client_secret))` header with
NO `client_id` in the body. Response `{access_token, expires_in?,
refresh_token?, scope?}` — a returned `refresh_token` ROTATES the stored
one (providers like Slack rotate on every refresh); a returned `scope`
narrows the stored one (note the asymmetry: `scope` is API-immutable on
update, but the IdP may shrink it — an operator cannot widen it back
without archive-and-recreate); absent `expires_in` → treat as long-lived
(re-check at the max ticker interval).

### 7B.3 Design — call-time token provider, lazy-first refresh, one in-process wake loop

**Revised after review round 1 (2026-07-09, §9)** — the round found three
genuine design bugs in the first draft: connect-time header freezing broke
mid-turn freshness, the cited redaction registry did not exist, and refresh
persists had no fencing against concurrent rotation/archive. The revision
below is the binding design.

**Injection: call-time token provider at the fetch layer (NOT connect-time
`requestInit`).** M2 bakes `Authorization` into the transport at
`McpConnection.connect` — a warm handle would keep sending an expired token
until failure (review: Codex-adv HIGH, Opus F3). M3 changes the injection
seam: the per-connection guarded fetch wrapper (we own every outbound
request, `mcp/fetch.ts:27`) adds the `Authorization` header on EVERY
request by calling an async token provider. Probe 49's both-legs evidence
carries over unchanged — the header still lands on each POST/GET; only its
source moves from a frozen option to a live closure. Consequences:

- Mid-turn expiry is covered: the provider refreshes when stale and the
  very next request on the SAME connection carries the fresh token — no
  reconnect, no live re-registration (which stays a §8 non-goal).
- Operator rotation propagates mid-turn too (stronger than hosted's
  "periodically re-resolved").
- `static_bearer` uses the same provider shape (returns the stored token,
  never refreshes); M1 unauthenticated connections pass no provider.
- This ANSWERS §3.4's open `authProvider` note: the SDK's OAuth
  `authProvider` seam is rejected — our fetch wrapper achieves per-request
  freshness without adopting an SDK surface designed around the
  authorization flows we must never expose. (Round-2 Opus seam-verified
  this against the SDK source: `_commonHeaders()` recomputes per send,
  emits no `Authorization` without `authProvider`/`requestInit` auth, and
  the wrapper receives a live `Headers` object — per-request injection is
  authoritative and unclobbered.)
- **The provider NEVER throws (round 2, Opus F3):** on ANY refresh
  failure — transient or permanent — it injects the best-available
  (stale) token and lets the server's 401 classify through the existing
  machinery. A throwing provider would reject `callTool` and tear down
  the handle as a transport failure; inject-stale keeps the graceful
  auth-failed path.
- **The provider caches (round 2, Opus F8):** the connection closure
  holds `{accessToken, expiresAt, authVersion}` in memory; the hot
  tool-call path re-enters the coordinator (and the store/`reveal()`
  decrypt) ONLY when the cache is stale, hinted, or the version bumped —
  never a per-request unseal.
- **Per-request means per-HTTP-request (round 2, Opus F7, SDK-verified):**
  a streaming response carries its open-time token, bounded by the
  operation timeout; the SDK's standalone SSE channel opens on reconnect,
  which re-runs the wrapper and picks up a fresh token. Not a freshness
  hole; stated so nobody mistakes it for one.

**401-hinted refresh (review: Opus F7; revised round 2).** Expiry-clock-
only refresh misses early revocation and consumer-supplied wrong
`expires_at`. Identity plumbing is explicit (round 2, independent P2):
each authenticated `McpConnection` carries `{credentialId, authVersion}`;
`onTransportFailure` threads it through, and unauthenticated/
`static_bearer` connections carry none (hint is a no-op). On an
auth-classified failure the failure path stamps `auth_hint_at = now` on
the credential; the provider attempts ONE forced refresh (single-flighted)
even if the clock says valid, and — because an auth rejection happens
BEFORE the tool executes, so no idempotency hazard exists — the bridge
retries the failed MCP request EXACTLY ONCE after a successful forced
refresh (round 2, Codex-adv: without this, the first call that discovers
a revoked token is a user-visible failure and the DoD's "keeps working"
overclaims). Bounding is a **forced-refresh minimum interval**
(`FORCED_REFRESH_MIN_INTERVAL`, 60s per credential) DECOUPLED from
`refresh_attempts` (round 2, Opus F1: the attempts counter resets on
every successful refresh, so a server that 401s unconditionally while the
IdP keeps issuing valid tokens would otherwise drive 1:1
request→token-endpoint amplification — the interval floor, not the
backoff, is what bounds that storm; within the interval, hints are
ignored, the stale/valid-per-clock token is injected, and the auth-failed
signal flows).

**Refresh execution: `RefreshCoordinator` (new, control-plane service
above the store — review: Opus F5 layering, independent-analysis async
finding).** The store stays synchronous SQLite. The coordinator owns:

- The **single-flight map** `Map<credentialId, Promise<RefreshOutcome>>` —
  shared by ALL FOUR triggers: lazy resolution, the ticker, 401-hints, and
  `mcp_oauth_validate` (review: Sonnet 2 — validate racing the ticker
  double-spends a rotating refresh token).
- The token-endpoint POST, built per `token_endpoint_auth` mode
  RFC-6749-correctly (review: independent M6, Opus F12): `none` →
  `client_id` in the form body only; `client_secret_post` → `client_id` +
  `client_secret` in the body; `client_secret_basic` → `Authorization:
  Basic base64(urlencode(client_id):urlencode(client_secret))` with NO
  `client_id` in the body — one client-auth method per request (§2.3).
- Response handling: `token_type` absent or case-insensitive `bearer`
  accepted, anything else → invalid-class; a returned `scope` is PERSISTED
  and used for subsequent refreshes (RFC §6 narrowing — review: Sonnet 12);
  a returned `refresh_token` rotates the stored one; `expires_in` →
  computed `expires_at`; absent `expires_in` → long-lived (re-check at max
  ticker interval); 200-with-error-body (no `access_token`) → treated as
  the error it is, not a success.
- **Hardening (review: independent H2, Opus F10)**: explicit timeout
  (30s, AbortSignal), response read capped at 64KB, `content-type` must be
  JSON; the guarded fetch's `redirect:"error"` stance is KEPT for token
  endpoints (a redirect would re-target a secret-bearing POST) and a
  redirect rejection is classified `transient` with a distinct, named log
  reason so a canonical-domain IdP misconfiguration is diagnosable, not a
  silent perpetual backoff (review: Sonnet 13).
- Failure classification (review: Opus F6; permanent set widened round 2,
  Codex + Opus F5): permanence keys on the OAuth error CODE — the
  PERMANENT set is `invalid_grant`, `invalid_client`,
  `unauthorized_client`, `invalid_scope`, `unsupported_grant_type` (all
  are operator/consumer misconfiguration or dead grants that retries
  cannot fix) → `refresh_status = invalid`,
  `next_refresh_at = NULL`, lazy/hinted refresh SKIPS (stale token still
  injected → the existing auth-failed signal; only a credential update or
  a successful validate-refresh clears it). ALL other failures — other
  4xx, 5xx, 429, network, redirect-rejection — → `transient` with
  exponential backoff, jittered, capped at 15 min, honoring `Retry-After`
  when present (also capped). `refresh_attempts` RESETS to 0 on success.

**Refresh persistence: compare-and-swap on a MONOTONIC version, fenced
(review: independent H4, Sonnet 3, Opus F1; fence corrected round 2 —
Codex, Opus F4, Codex-adv all hit it).** `vault_credentials` gains an
`auth_version` INTEGER column: a monotonic counter incremented by every
path that touches auth material — credential token update, refresh
persist, archive, delete. It replaces two things the round-1 draft
overloaded onto wallclock `updated_at`: (1) the CAS fence — `UPDATE
vault_credentials SET … auth_version = auth_version + 1 WHERE id = ? AND
auth_version = <version read before the POST> AND archived_at IS NULL`,
immune to same-millisecond collisions and, deliberately, NOT bumped by
cosmetic edits (`display_name`/metadata), so a metadata edit racing a
rotating refresh no longer burns the grant (round-2 Codex's sharpest
case); and (2) the M2 fingerprint component — `credentialId:authVersion`
— which as a side effect stops cosmetic edits from resetting the M2
failure budget (a small M2 correctness improvement for free). ONLY if the
row-update takes effect does the secret row get written, in the same
transaction. Stale version → the refresh outcome is DISCARDED; archived
or deleted meanwhile → discarded, never resurrecting a purged secret
(M2's revocation guarantee — Sonnet 3's sharpest round-1 case).
**Discard semantics for the caller (round 2, Opus F2 + Sonnet):** after a
discard the coordinator RE-READS the row and returns the currently
persisted token to the in-flight dial and every single-flight awaiter
(the operator's newer token, normally); if the re-read token is itself
stale/missing, it returns the best available stale token and lets the
auth-failed signal flow — a discarded refresh NEVER retries and never
loops back into single-flight. The validate handler re-probes with the
same re-read token.
The **burned-token crash window** cannot be closed locally: between the
provider rotating the refresh token server-side and our commit, a process
crash loses the new tokens and the stored refresh token is dead (Opus F1
— the risk is the network↔persist gap, not local write atomicity). OMA
narrows it by persisting immediately on response receipt (milliseconds,
process-crash-only) and ACCEPTS the residual as a named disposition: the
credential surfaces as `invalid` on the next refresh attempt and requires
a consumer re-auth — same recovery as any provider-side revocation. No
write-ahead journal; the appliance does not grow one for a
milliseconds-wide window.

**Layer 1 — lazy refresh at resolution (correctness).** Resolution
becomes ASYNC end-to-end (review: independent H1 — `McpCredentialResolver`
returns a Promise; store stays sync; the coordinator sits between).
`prepareMcp` resolves credentials INSIDE the per-server parallel dial map,
preserving M1's no-serial-stalls property. For an `mcp_oauth` credential
with `expires_at - SKEW <= now` (SKEW 60s), `auth_hint_at` set, or a
long-lived re-check due, the coordinator refreshes before returning the
token. Cost: one ~300ms round-trip on the first use after expiry.

**Layer 2 — one in-process ticker (freshness).** A single `setTimeout`
loop; **the credential row IS the job row**: columns `next_refresh_at`,
`refresh_attempts`, `refresh_status` (plus `auth_hint_at`). Loop:
`MIN(next_refresh_at)` over active mcp_oauth rows → sleep until then,
capped at 15 min AND floored at 30s (review: Sonnet 4 — a token with TTL
< LEAD would otherwise compute a permanently-past `next_refresh_at` and
thrash; policy made branch-explicit in round 2 (Codex): TTL ≥ LEAD →
`next_refresh_at = expires_at - LEAD`; TTL < LEAD → `next_refresh_at =
now + max(TTL/2, FLOOR)` — a 2-minute token refreshes at ~60s, not at
the 30s floor; LEAD 5 min, FLOOR 30s). Restart recovery: recompute next
wake from SQLite.
**Ownership (review: independent M7)**: the loop is created by
`createDeploymentControlPlane`, and the deployment close path closes it
BEFORE stores close — `createWakeLoop`'s `close()` cancels the timer and
awaits any in-flight `run()` (review: Sonnet 5 — this codebase's known
teardown bug class).

**Reusable primitive, deliberately tiny.** `createWakeLoop({ nextWakeAt,
run, maxSleepMs, minSleepMs, onError })` (~60 lines,
`src/control-plane/wake-loop.ts`): no persistence of its own; `close()`
is await-safe. The sessions snapshot-sweep machines may adopt it later —
named follow-up, NOT migrated in M3.

**Multi-node seam.** Store method `claimDueRefreshes(now, limit)` — in
the Postgres era an `UPDATE … RETURNING` claim; nothing above the store
changes. Single-flight stays in-process per the single-node deployment
contract (0113 D9 basis).

**Storage (review: Sonnet 20/21, Opus F9 — made explicit).**

- **Structural, non-secret fields become nullable columns** on
  `vault_credentials` (ALTER TABLE via the `ensureVaultIdsColumn`
  pattern): `token_endpoint`, `client_id`, `scope`,
  `token_endpoint_auth_type`, `expires_at`, plus the scheduling state
  (`next_refresh_at`, `refresh_attempts`, `refresh_status`,
  `auth_hint_at`). The ticker's due-row SELECT and the readable API
  subset never touch `reveal()`. `static_bearer` rows carry NULLs; the
  ticker query filters `auth_type = 'mcp_oauth'` — locked by a mixed-row
  migration test.
- **Secret material is ONE sealed JSON row** (same `vault/{v}/{c}` name):
  `{access_token, refresh_token?, client_secret?}` — refresh rotates
  access+refresh atomically inside the CAS transaction. **The dispatch
  point is explicit** (review: Sonnet 20 — the M3 blind spot): the store
  grows a typed accessor keyed off `auth_type` that JSON-parses the blob;
  `resolveCredential` for mcp_oauth returns the extracted `access_token`
  ONLY — the blob string never leaves the store; a malformed blob is
  treated as secret-missing (M2's degradation disposition, extended and
  named for oauth). `static_bearer` rows stay raw strings (documented
  asymmetry, discriminated by `auth_type`).

**Redaction: build the mechanism the draft assumed (review: Opus F2 —
verified false seam).** `logging.ts` has NO dynamic registry and its
fixed patterns cannot match arbitrary OAuth token shapes in
server-controlled free text. M3 adds `scrubKnownSecrets(text,
values: readonly string[])` — exact-value replacement, no registry: each
chokepoint that serializes server-controlled bodies ALREADY holds the
live secret values (the coordinator holds tokens pre/post rotation; the
validate handler holds the credential's secrets) and scrubs its own
output before anything is returned, persisted, or logged. Applied to:
`mcp_probe.http_response.body`, token-endpoint error details in audit
logs, refresh failure messages (which remain fixed strings per M2 — belt
and braces), and — round 2, Codex-adv HIGH — **ordinary MCP tool-result
content in the bridge**: a hostile server can echo the injected bearer
into a tool result, which persists to `agent.mcp_tool_result` AND returns
to the model — the latter directly violates "credentials the agent cannot
read". The bridge's result normalization gains the active connection's
known-secret values and scrubs content before persist/return. This
retroactively covers M2 `static_bearer` tokens too (the gap exists on
main today; M3 closes it for both credential types). **Stated
limitation:** exact-value scrubbing catches verbatim echoes only —
base64/URL-encoded/split reflections pass (the server already holds the
plaintext, so this is defense-in-depth for log/event readers, not an
exfil barrier); values shorter than 8 chars are not scrubbed
(pathological replacement guard). Additionally the form-body params `refresh_token` /
`client_secret` join a body-param scrub pattern (first-param form
included — `QUERY_CREDENTIAL` requires a `[?&]` prefix and would miss it;
review: Opus F11).

**Egress posture (review: Codex P2 + independent H3 + Sonnet 6 + Opus F8
— four reviewers, one hole).** ALL M3-originated egress is gated on
`OMA_ENABLE_MCP`: the ticker does not start when off; lazy/hinted refresh
is inherently gated (runs only on dials); and **`mcp_oauth_validate`
returns the wire-shaped 400 `invalid_request` ("MCP is disabled on this
deployment") BEFORE any probe or token-endpoint dial** when the gate is
off — locked by a zero-network-call test. Vault CRUD stays ungated (M2
posture, storage is inert).

**`token_endpoint` validation is STRICTER than MCP server URLs (review:
Codex-adv H2, independent M5).** At create/update: `https:` ONLY, no
userinfo, no fragment, ≤ 2048 chars, and the same literal-IP/blocked-range
pre-check the dial path enforces. The hermetic fixture reaches the
coordinator through an explicit `allowInsecureTokenEndpoint` test seam
(same pattern as the M1 `allowAddress` SSRF seam) — never reachable from
production wiring.

**`mcp_oauth_validate` (synchronous handler).** Gate check (above) →
active credential lookup (archived → 404; static_bearer → 400 interim,
probe 52) → (1) `mcp_probe`: initialize-dial `mcp_server_url` via
`McpConnection` + guarded fetch with the CURRENT access token; capture
status/content-type/body capped at 4KB with `body_truncated`, body passed
through `scrubKnownSecrets` (a hostile server echoing the access token
must not get it reflected back — M2's echoing-401 lesson applied to this
new surface); (2) on 401/403 with a refresh block → attempt a refresh
THROUGH the coordinator (single-flight, CAS; success clears `invalid` and
reschedules `next_refresh_at` — review: Opus F6) → re-probe; (3) map to
`valid|invalid|unknown` per docs semantics; populate `refresh.status`
(`no_refresh_token` when absent). **`refresh.http_response` NEVER carries
a token-bearing body** (review: Opus F4 — the 200 grant response IS the
secret): status + content-type only, body omitted; probe 52 checks what
hosted does, but OMA's floor is committed regardless.

**Buy-vs-build (unchanged):** hand-roll the refresh POST (~50 lines with
the hardening above) rather than depend on `openid-client` — its value is
discovery/DPoP/PKCE/authz flows, all non-goals; a dependency whose main
surface is the flow we must never expose is negative value.

### 7B.4 Probes (before implementation)

- **Probe 52 (hosted, live)** — `scratch/52-mcp-oauth-hosted-probe`:
  mcp_oauth credential CRUD wire shapes (readable `auth` subset on
  create/get/list — the M3 blind spot; update-merge semantics on the
  `refresh` block; structural immutability of `token_endpoint`/`client_id`
  → expected 400); `mcp_oauth_validate` response field set for a bogus
  credential (captures `invalid`/`unknown` + `mcp_probe`/`refresh` shapes
  live; `has_refresh_token` both ways; **whether hosted's
  `refresh.http_response` is ever populated with a token-bearing body** —
  review Opus F4, OMA's own no-body floor is committed either way; the
  `?beta=true` query quirk from the docs curl example); validate called on
  a `static_bearer` credential and on an **archived** credential. A
  `valid` capture needs a real OAuth grant — best-effort (skip if no
  grant is at hand; the shape evidence is the requirement).
- **Probe 53 (real providers, live, bogus tokens)** — review Sonnet 11:
  the hermetic fixture encodes the plan author's own RFC assumptions
  while the motivating providers were never checked.
  `scratch/53-oauth-provider-probe`: POST the refresh grant with a
  syntactically-plausible bogus refresh token at the Slack, Linear, and
  Notion token endpoints; capture whether form-encoding is accepted (vs a
  JSON-required error), the error taxonomy (`invalid_grant` reachable?),
  and each provider's documented rotation policy (docs read). No real
  grants required; request-format acceptance + error shapes is the
  evidence sought.
- **No SDK probe needed** — M3 adds no new SDK surface (probe 49 already
  pinned that headers land on both legs; moving the injection source to
  the fetch wrapper is OMA-owned code). The OAuth token-endpoint fixture
  is a test fixture, not a probe: hermetic HTTP server implementing the
  refresh grant for all three `token_endpoint_auth` modes, token rotation,
  `expires_in` variants (absent/0/negative/short), `invalid_grant`,
  other-4xx, 200-with-error-body, non-JSON body, oversized body, redirect,
  429 with `Retry-After`, and 500/timeout modes.

### 7B.5 Testing (M3)

- **Refresh unit matrix** (token-endpoint fixture): all three auth modes
  (Basic = header only with urlencoded-then-base64 credentials and NO body
  client_id; post = body id+secret; none = body id), refresh-token
  rotation persisted atomically with the new access token (inject a
  metadata failure → old tokens still resolve), `expires_in` → computed
  `expires_at`; `expires_in` absent → long-lived policy; `expires_in`
  0/negative and `expires_at` already past at create → immediate-due
  without thrash (FLOOR honored); `invalid_grant` →
  `refresh_status=invalid` + lazy/hinted-skip; other-4xx and 500 and
  redirect → `transient` + backoff written; 200-with-error-body → error;
  non-JSON body → error; oversized body → capped read, error; 429 →
  `Retry-After` honored (capped); timeout aborts at the deadline; `scope`
  narrowing persisted and used on the next refresh; unexpected
  `token_type` → invalid-class; `refresh_attempts` resets on success.
- **CAS/fencing matrix** (round 1's race theme + round-2 fence fix):
  refresh completes after an operator rotation → outcome discarded,
  operator tokens stand, AND the caller receives the re-read operator
  token (caller-visible semantics locked, not just DB state); after
  archive → discarded, purged secret NOT resurrected (`reveal` still
  undefined); after hard delete → no orphan secret row; **fixed-clock
  same-millisecond regression**: operator rotation stamped in the same ms
  as the coordinator's pre-POST read cannot be clobbered (`auth_version`
  fence, round-2 Codex/Opus/Codex-adv); cosmetic `display_name`/metadata
  edit racing a rotating refresh does NOT discard it (auth_version
  unbumped) and does NOT reset the M2 failure budget; validate-refresh
  racing the ticker → single-flight, fixture sees exactly one POST;
  401-hint racing a lazy resolution and racing the ticker → single POST
  each (the two untested pairwise races from round 2).
- **Lazy layer**: expired credential + dial → refresh in-path → connect
  fixture observes the NEW token; **mid-turn**: a warm connection's next
  request after expiry carries the refreshed token with NO reconnect
  (fetch-layer provider — the round-1 headline fix, asserted at the
  fixture); **401-hint end-to-end** (round 2): warm connection + early
  revocation (fixture rejects a clock-valid token) → forced refresh → the
  SAME failed request retried exactly once → succeeds, user-visible
  failure count zero; a second 401 inside `FORCED_REFRESH_MIN_INTERVAL` →
  no token-endpoint POST (the storm bound — fixture counts POSTs under a
  hostile always-401 server); provider transient-refresh-failure →
  injects stale, NO throw, auth-failed classification (not handle
  teardown); provider cache: N tool calls on a fresh token → zero
  additional store reads/decrypts; concurrent dials single-flight;
  `invalid` status → no refresh attempt, stale token injected,
  auth-failed event flows; fixed-token credential (no `refresh` block)
  past expiry → no refresh attempt, auth-failed event on dial.
- **Ticker layer**: due row refreshed without any dial; backoff on 5xx;
  invalid → proactive stops; credential update clears status +
  reschedules; successful validate-refresh clears invalid + reschedules;
  restart recompute (new store instance → correct next wake, no replay);
  short-TTL token → refresh cadence floored (no token-endpoint hammering);
  `OMA_ENABLE_MCP` off → loop never starts; wake-loop unit tests
  (next-wake ordering, min/max sleep clamps, close() cancels AND awaits an
  in-flight run, onError doesn't kill the loop); deployment close shuts
  the loop before stores (no refresh-against-closed-DB).
- **Fingerprint propagation**: refresh bumps `updated_at` → exhausted
  budget resets and the next operation redials with the refreshed token
  (M2's rotation test extended to refresh-driven rotation).
- **Storage/dispatch**: the `auth_type`-keyed JSON-blob accessor is
  boundary-tested — mcp_oauth resolution returns the extracted
  access_token ONLY (a blob string in an Authorization header is the
  named failure this locks out — review Sonnet 20); malformed blob →
  secret-missing degradation; mixed-row migration test (M2 static_bearer
  rows survive the ALTER with NULLs; ticker due-query excludes them);
  `rotateMasterKey` rewraps the JSON secret row.
- **Wire matrix** (vaults-api): mcp_oauth create/rotate round-trips;
  write-only fields (`access_token`, `refresh_token`, `client_secret`)
  never in any serialized response; structural immutability
  (`token_endpoint`, `client_id`, `mcp_server_url`) → 400; token_endpoint
  validation (http → 400, userinfo → 400, fragment → 400, oversize → 400);
  `expires_at` interim rule (required with `refresh` → 400 when missing;
  optional without) locked; refresh-block merge update; validate endpoint
  statuses (valid via fixture, invalid, unknown, no_refresh_token,
  static_bearer-called, archived → 404, gate-off → 400 with ZERO network
  calls); **blocked-range literal-IP token_endpoint**
  (`https://169.254.169.254/token`) → 400 (round-2 Sonnet — the SSRF
  check itself, not just syntax); **`allowInsecureTokenEndpoint`
  mutation pair** (seam absent → http fixture unreachable; seam set →
  reachable; production wiring never sets it — M1 `allowAddress`
  discipline, round-2 Sonnet HIGH); redirect rejection carries its
  DISTINCT named log reason (diagnosability lock, not just the transient
  outcome); scope-absent refresh response preserves the stored scope;
  `mcp_probe` oversized-body → 4KB truncation + flag;
  `refresh.http_response` carries no body on the valid path.
- **Leak sweep**: access_token AND refresh_token AND client_secret absent
  from all persisted events, API responses, and captured logs across a
  full refresh cycle and a validate call — including a hostile MCP server
  echoing the access token into its 401 body (`scrubKnownSecrets` at the
  validate surface), **a tool whose RESULT echoes the current and the
  rotated access token → scrubbed from `agent.mcp_tool_result`, the API/
  event stream, AND the model-visible return** (round-2 Codex-adv HIGH;
  fixture-driven, covers static_bearer retroactively), and a token
  endpoint echoing the refresh_token into an error body;
  `scrubKnownSecrets` unit tests incl. pathological values (empty/short
  secrets not scrubbed per the stated ≥8-char guard, no corruption of
  unrelated output); form-body param scrub incl. first-param position.
- **Live-style smoke** (`scratch/54-mcp-oauth-live-smoke.ts`, smoke-51
  recipe): full stack, real model turn — OAuth token-endpoint fixture +
  bearer-checking MCP fixture; session dials with a pre-expired access
  token → lazy refresh → tool call succeeds → rotate at the fixture
  mid-session → next tool call carries the rotated token on the SAME
  handle → sweep proves no secret material in events.

### 7B.6 Docs (M3)

- `dev-deployment.md`: mcp_oauth walkthrough (consumer runs the OAuth
  dance; store tokens; refresh is automatic), validate endpoint, the
  refresh_status/next_refresh_at semantics, no-webhooks note.
- `threat-model.md`: token-endpoint dials as a control-plane egress class
  (same SSRF guard), refresh secrets at rest (one sealed JSON row).
- Parity ledger: webhooks (`vault_credential.refresh_failed`) still a
  named gap — `refresh_status` + metric is the OMA-native signal;
  credential-delete body still unprobed (7A disposition stands).
- Roadmap 0114: capability item 3 fully DONE on merge.

### 7B.7 M3 non-goals

- OAuth authorization flow / consent / DCR / PKCE — standing product
  boundary (§8).
- Webhooks — no webhook surface; `refresh_status` + metrics instead.
- `openid-client` (or any OAuth library) dependency — hand-rolled RFC 6749
  §6 refresh only (§7B.3 buy-vs-build).
- Multi-node refresh claims — `claimDueRefreshes` seam only; single-node
  single-flight is the deployment contract.
- Migrating the sessions snapshot-sweep retry machines onto
  `createWakeLoop` — named follow-up issue after M3.
- `environment_variable` credentials — unchanged non-goal (§8).

### 7B.8 Open questions (probes 52/53 / review)

1. Readable `auth` subset for mcp_oauth credential responses — probe 52.
2. `mcp_oauth_validate` on a `static_bearer` credential — probe 52
   (interim: 400); on an archived credential — probe 52 (interim: 404).
3. Whether hosted requires `expires_at` on create when a `refresh` block
   is present (docs example always includes it) — probe 52; interim:
   required with `refresh`, optional without (treat absent as long-lived).
4. `validated_at`/probe ordering fields in the validation object under a
   `valid` outcome — probe 52 best-effort (needs a live grant).
5. Whether hosted's `refresh.http_response` ever carries a token-bearing
   body — probe 52; OMA's no-body floor stands regardless (§7B.3).
6. Slack/Linear/Notion token-endpoint request-format acceptance and error
   taxonomy — probe 53 (bogus tokens; shapes the fixture's realism).

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

**Live OMA smoke 48 (2026-07-07, `scratch/48-mcp-live-smoke.ts`):** the full
production stack end-to-end — real model turn (claude-sonnet-4-6) through
the real runner/Pi loop/bridge with the PRODUCTION SSRF guard against the
public DeepWiki server; correlated `agent.mcp_tool_use`/`mcp_tool_result`
persisted and the model answered from the tool output. Caught a shipping
bug hermetic tests could not: undici 8.7's connect path spent ~15s per new
connection to dual-stack hosts (v6-first racing, ignores lookup order),
timing out MCP handshakes on networks without v6 egress. Fixed by pinning
undici to 7.28.0 (Node 24's bundled family, 533ms) + IPv4-first ordering in
the guarded fetch.

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

**M2 amendment review round 1 (2026-07-08, engineer pass on §7A):** 5
findings, all valid, all folded: (1) failure-budget must reset on
credential change — real blocker, exhaustion would have outlived rotation
(§7A.3 fingerprint rule + §7A.5 test); (2) vault↔secret write ordering
across separate sqlite handles, failing toward less secret retention
(§7A.3); (3) master-key-absent behavior made explicit — credential writes
fail wire-shaped, metadata surfaces stay up (§7A.3); (4) `/v1/vaults` must
be registered in the managed-route auth prefix list, locked by 401 +
cross-workspace-404 tests (§7A.3/§7A.5); (5) reserved `vault/`
secret-name prefix compatibility statement (§7A.3). None affect the wire
contract: budget policy, write ordering, and route gating are internal;
the prefix lives on the OMA-only `/v1/secrets` surface; the master-key
error reuses the existing wire-shaped `invalid_request` envelope.

**Round 2 (same day):** finding 2's premise corrected — durable
deployment already shares one `DatabaseSync` across all stores
(`deployment-storage.ts:189`) and `withSqliteTransaction` is
savepoint-based (nests), so vault credential writes get a REAL shared
transaction, not best-effort ordering; the ordering rules survive as
in-transaction invariant + fallback (§7A.3). With that, §7A judged
implementation-ready (pending probes 49/50).

**M2 implementation review, 2026-07-08:** merge-blockers fixed before merge:
creation-time `vault_ids` are threaded into pre-commit runtime preparation
(file-resource sessions no longer prewarm unauthenticated MCP handles);
generic `/v1/secrets` delete rejects the reserved `vault/` namespace
including encoded slash params; MCP connection failures persist fixed
token-free messages instead of SDK/server-controlled response text; JSON
serialized `authorization` fields are scrubbed as a log backstop; exhausted
handles are evicted before reuse so a rotated credential is picked up on the
next operation; `auth_failed` is a first-class MCP connection metric outcome;
rotate-without-master-key returns the same 400 guidance as create; vault
hard delete returns the probe-shaped `200 {id,type:"vault_deleted"}`.
Test coverage added for direct `SqliteVaultStore.resolveCredential`
(first-vault-wins, archived skip, exact URL), transaction rollback across
secret+metadata writes, master-key rewrap of vault tokens, bearer fixture
wire auth, reserved-secret delete, session-create negatives, max-20,
include_archived, pagination, immutable `mcp_server_url`, and token-free
failure events.

Explicit M2 dispositions after review:

- **Vault list envelope:** OMA keeps the existing house list envelope
  (`data`, `has_more`, `next_page` with `next_page: null` on the final page)
  even though probe 50 observed hosted vaults omit false/null pagination
  fields. This is a deliberate house-wide deviation for now, not an
  accidental implementation detail; revisit with the broader list-envelope
  parity pass rather than making vaults the one inconsistent OMA list.
- **Credential delete response:** upstream credential-delete body was not
  captured by probe 50. OMA keeps 204 empty for credential delete until a
  targeted hosted probe proves otherwise.
- **Exhausted-server rebuild cost:** a session whose MCP server remains
  permanently exhausted can rebuild its handle/sandbox on each operation so
  credential rotation is observed immediately. Accepted M2 tradeoff: this is
  bounded by active user operations and preferable to waiting up to the
  15-minute idle TTL after a token is fixed.
- **Missing secret after metadata survives:** if the backing reserved secret
  row disappears, resolution returns undefined and the MCP dial proceeds
  unauthenticated. This is a v1 degradation path, not a confidentiality leak;
  the reserved-delete guard removes the generic API path that could trigger
  it. A future hardening pass can surface this as a configuration error
  instead of unauthenticated fallback.

**M3 amendment review round 1 (2026-07-09)** — Codex (review +
adversarial), Opus, Sonnet, plus an independent engineer pass against
`80f0c67`. ~35 findings, deduplicated to 11 clusters, all folded into the
§7B revision; three were genuine design bugs in the first draft:

| Cluster | Findings | Disposition |
|---|---|---|
| 1 — mid-turn freshness | Codex-adv HIGH, Opus F3+F7 | Injection moved from connect-time `requestInit` to a call-time async token provider at the fetch layer (per-request header from a live closure; no reconnect, no re-registration); 401-hinted forced refresh covers early revocation / wrong `expires_at`; §3.4's `authProvider` question answered (rejected). |
| 2 — async seam + layering | independent H1, Opus F5 | `McpCredentialResolver` becomes async; resolution moves inside the parallel dial map (M1 no-serial-stalls preserved); new `RefreshCoordinator` service owns refresh HTTP + single-flight; store stays sync SQLite. |
| 3 — refresh write integrity | independent H4, Sonnet 1+3, Opus F1 | CAS persist (`WHERE updated_at = ? AND archived_at IS NULL`, secret write only after the row-update takes) — stale/archived → discard, no clobber, no purged-secret resurrection; burned-token crash window narrowed to persist-on-receipt and ACCEPTED as a named §7B.1 residual (network↔persist gap, correctly rediagnosed per Opus F1). |
| 4 — validate endpoint | Codex P2, independent H3, Sonnet 2+6+17, Opus F4+F8 | Gated on `OMA_ENABLE_MCP` (wire-shaped 400 before any dial, zero-egress test) — four reviewers found this hole independently; validate's refresh joins the single-flight map; `refresh.http_response` never carries a body; archived → 404; success clears `invalid` + reschedules. |
| 5 — token_endpoint strictness | Codex-adv HIGH, independent M5 | https-only, no userinfo/fragment, ≤2048, literal-IP pre-check at write time; hermetic fixture via explicit `allowInsecureTokenEndpoint` test seam. |
| 6 — refresh HTTP hardening | independent H2+M6, Opus F6+F10+F12, Sonnet 9+12+13+15+16 | Timeout 30s + 64KB body cap + JSON checks; RFC-correct per-mode client auth (Basic = urlencoded-then-base64 header only); `invalid_grant`-keyed permanence (other 4xx transient); scope narrowing persisted; token_type checked; Retry-After honored; redirect rejection kept and classified transient with a named log reason. |
| 7 — scheduling | Sonnet 4+5+10, independent M7 | Min-sleep floor (short-TTL thrash), `refresh_attempts` reset on success, wake loop owned by the deployment and closed before stores, `close()` awaits in-flight runs. |
| 8 — storage/dispatch | Sonnet 20+21, Opus F9+F13 | Structural fields as nullable columns (bulk due-SELECT never touches `reveal()`); `auth_type`-keyed JSON-blob accessor with a named boundary test (blob string never leaves the store — the leak Sonnet 20 projected); mixed-row migration test; oauth secret-missing degradation named. |
| 9 — redaction reality | Opus F2 (verified false seam), F11 | The draft cited a redaction registry that does not exist; M3 builds `scrubKnownSecrets(text, values)` — exact-value scrubbing at the chokepoints that hold the live secrets; form-body param patterns added incl. first-param. |
| 10 — probe rigor | Sonnet 11, Opus probe note | Probe 53 added (Slack/Linear/Notion token endpoints, bogus tokens — request-format + error taxonomy); probe 52 gains `refresh.http_response` confidentiality + validate-on-archived; fixture modes expanded to the full quirk matrix. |
| 11 — test-matrix gaps | Sonnet 1-10+17-22 | §7B.5 rewritten: CAS/fencing matrix, mid-turn warm-connection assertion, gate-off zero-egress, boundary tests for dispatch/migration/expiry edges, access-token echo in the leak sweep, smoke renumbered 54 with mid-session rotation on the same handle. |

Endorsed unchanged by reviewers: the lazy-first + ticker skeleton,
credential-row-as-job-row with recompute-from-SQLite recovery,
`createWakeLoop` minimalism, the `openid-client` buy-vs-build rejection,
and the fingerprint machinery reuse (Opus verified the seam).

**M3 amendment review round 2 (2026-07-09)** — same panel against
`4cd4abc`, briefed as a verification pass. Unanimous: the round-1
architecture holds (Opus seam-verified the fetch-layer injection against
the SDK source — per-send header recompute, no clobber; the independent
pass judged all round-1 majors "actually folded, not papered over").
12 findings, all precision pins, all folded:

| Item | Findings | Disposition |
|---|---|---|
| `auth_version` fence | Codex P2, Opus F4, Codex-adv HIGH (3 independent hits) | CAS moves off wallclock `updated_at` onto a monotonic auth-material counter; cosmetic edits no longer burn racing refreshes NOR reset the M2 failure budget (free M2 improvement); fixed-clock same-ms regression test. |
| Tool-result scrub | Codex-adv HIGH | `scrubKnownSecrets` threaded into bridge result normalization — a server echoing the bearer into a tool result reached persisted events AND the model (violating "credentials the agent cannot read"); gap exists on main for M2 static_bearer, M3 closes both; echo-fixture test incl. model-visible return. |
| One-shot 401 retry | Codex-adv MED | The failed request that discovers a revoked token is retried exactly once after a successful forced refresh (auth rejection precedes tool execution — no idempotency hazard); DoD upgraded to "no user-visible failed call". |
| Forced-refresh interval floor | Opus F1 | The round-1 "bounded" claim was false for the success-401 path (`refresh_attempts` resets on success); a per-credential 60s forced-refresh minimum interval bounds hostile-server amplification. |
| CAS-discard caller semantics | Opus F2, Sonnet F3 | Re-read row → return persisted token to the dial and all single-flight awaiters; still-stale → best-available stale; never retry-loop. |
| Provider never throws / caches | Opus F3+F8 | Inject-stale-on-any-refresh-failure (throw = spurious handle teardown); connection closure caches `{token, expiresAt, authVersion}` — no per-request unseal. |
| Permanent-4xx set | Codex P2, Opus F5 | `invalid_client`, `unauthorized_client`, `invalid_scope`, `unsupported_grant_type` join `invalid_grant`. |
| Half-life branch | Codex P2 | Formula made branch-explicit (2-min token → ~60s, not the 30s floor). |
| §7B.2 Basic consistency | independent P2 | Wire-contract paragraph rewritten per-mode; scope API-immutable vs IdP-narrowable asymmetry noted. |
| 401-hint identity | independent P2 | Connections carry `{credentialId, authVersion}`; `onTransportFailure` threads it; unauth/static → no-op. |
| SSE bound stated | Opus F7, Sonnet F7 | SDK-verified benign (standalone SSE opens on reconnect → fresh token); stated so it isn't mistaken for a freshness hole. |
| Test locks | Sonnet F1+F2+F4+F5+F6+F10 | Seam mutation pair, blocked-range literal-IP, 401-hint pairwise races, redirect log-reason lock, scrub pathological values (≥8-char guard), fixed-token expiry path. |

Verdict after fold: §7B implementation-ready pending probes 52/53
(both explicitly endorsed as the remaining gates by the round-2 panel).
