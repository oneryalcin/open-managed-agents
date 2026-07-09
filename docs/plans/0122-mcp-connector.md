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
  access token; when the token expires, OMA refreshes it via the stored
  `refresh` block and the session keeps working **without a restart and
  without operator action** — proven by a live-style smoke against a
  hermetic OAuth token-endpoint + bearer-checking MCP fixture pair.
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
buy-vs-build): `POST token_endpoint` form-encoded
`grant_type=refresh_token&refresh_token=…&client_id=…[&scope=…]`, client
authentication per `token_endpoint_auth` (`none` → client_id in body only;
`client_secret_basic` → `Authorization: Basic`; `client_secret_post` →
`client_secret` in body). Response `{access_token, expires_in?,
refresh_token?}` — a returned `refresh_token` ROTATES the stored one
(providers like Slack rotate on every refresh); absent `expires_in` →
treat as long-lived (re-check at the max ticker interval).

### 7B.3 Design — lazy-first refresh, one in-process wake loop

The load-bearing decision (user-ratified): **refresh needs no worker to be
correct, only to be fresh.** Upstream's own lifecycle doc says
re-resolution "also refreshes the access token if it has expired" — the
trigger is expiry-at-resolution. So M3 is two layers, where the loop is an
optimization that can die without breaking anything:

**Layer 1 — lazy refresh at resolution (correctness).**
`resolveCredential` (store, `vaults/store.ts:430`) already runs on every
dial. For an `mcp_oauth` row with `expires_at - SKEW <= now` (SKEW 60s,
constant with a loud comment), refresh synchronously in the dial path:
token-endpoint POST **through the SSRF-guarded fetch** (`mcp/fetch.ts:27`
— token endpoints are operator-supplied URLs, exactly the same threat
class as server URLs), persist, then inject the fresh token. Persisting
bumps `updated_at` → the M2 fingerprint machinery propagates rotation for
free (budget reset, next-handle pickup). Cost: one ~300ms round-trip on
the first dial after expiry — noise next to sandbox+model latency. Ships
first; everything else layers on.

**Layer 2 — one in-process ticker (freshness).** A single `setTimeout`
loop in the existing control-plane process. **No job table — the
credential row IS the job row**: new columns `next_refresh_at`,
`refresh_attempts`, `refresh_status` (`ok|invalid|transient`) on
`vault_credentials` (ALTER TABLE via the `ensureVaultIdsColumn` pattern,
`sessions/store.ts:606`). Loop: `MIN(next_refresh_at)` over active
mcp_oauth rows → sleep until then, capped at 15 min → refresh due rows
with jitter. Restart recovery is "recompute next wake from SQLite" —
nothing to replay. Scheduling policy: on create/rotate,
`next_refresh_at = expires_at - LEAD` (LEAD 5 min); transient failure →
exponential backoff capped at 15 min, jittered; permanent failure (4xx
from the token endpoint) → `refresh_status = invalid`,
`next_refresh_at = NULL` (proactive stops; a later credential update
clears the status and re-schedules).

**Reusable primitive, deliberately tiny.** `createWakeLoop({ nextWakeAt,
run, maxSleepMs, onError })` (~60 lines, new
`src/control-plane/wake-loop.ts`): no persistence of its own — state lives
in domain tables; `close()` clears the timer. The sessions service's two
snapshot-sweep retry machines could adopt it later — named follow-up, NOT
migrated in M3 (scope discipline). This is the whole "background
infrastructure class": one file, one timer, zero processes.

**Single-flight + the multi-node seam.** Both layers share an in-process
`Map<credentialId, Promise<RefreshOutcome>>` — a lazy dial and the ticker
never double-refresh; concurrent dials for the same credential await one
refresh. Correct under the documented single-node deployment contract
(same basis as admission counters, 0113 D9). The store grows
`claimDueRefreshes(now, limit)` — in the Postgres era that becomes an
`UPDATE … RETURNING` claim and nothing above the store changes (the same
deliberate-seam pattern as sqlite→postgres itself).

**Secret storage.** `mcp_oauth` secret material is ONE `SecretsStore` row
(same `vault/{v}/{c}` name) holding JSON `{access_token, refresh_token?,
client_secret?}` — one seal path, and a refresh rotates access+refresh
tokens **atomically** in the existing shared-transaction write
(`store.ts:284` pattern). `static_bearer` rows stay raw strings (no
migration; `auth_type` column discriminates — asymmetry documented in the
store).

**Failure semantics (no webhooks — standing gap).** Token-endpoint 4xx →
`refresh_status = invalid`; resolution still injects the stale token so
the MCP server's 401 produces the existing `mcp_authentication_failed_error`
signal users already handle — and lazy refresh SKIPS further attempts
while `invalid` (else every dial hammers a dead token endpoint).
5xx/429/network → `transient`, backoff, stale token still injected
meanwhile. One new metric:
`oma_vault_credential_refreshes_total{outcome: ok|invalid|transient_error}`
+ audit log line (redaction chokepoint already covers headers; add the
form-encoded `refresh_token`/`client_secret` body params to the
`QUERY_CREDENTIAL`-style scrub patterns — same shape, different location).

**Egress posture.** Proactive ticker starts only when `OMA_ENABLE_MCP` is
on — a deployment with MCP disabled must not originate token-endpoint
dials (lazy refresh is inherently gated: it only runs on dials, which the
gate already stops). Vault CRUD stays ungated (M2 posture).

**`mcp_oauth_validate` (synchronous, no background involvement).**
Handler: (1) `mcp_probe` — initialize-dial the credential's
`mcp_server_url` via `McpConnection` + guarded fetch with the current
access token, capture status/content-type/body (truncated, capped — the
body is server-controlled text landing in an API response: cap at 4KB,
`body_truncated` flag; it does NOT flow through session events so the M2
token-leak class doesn't apply, but scrub it anyway); (2) if the probe
401/403s and a refresh block exists → attempt a real refresh → re-probe;
(3) map to `valid|invalid|unknown` per the docs semantics + populate
`refresh.status` (`no_refresh_token` when absent — docs-literal). Probe 52
pins the exact field set and the static_bearer-called-on behavior.

**Buy-vs-build (closes §7 M3's open note):** hand-roll the refresh POST
(~30 lines, RFC 6749 §6 with three auth modes) rather than depend on
`openid-client` — that library's value is discovery/DPoP/PKCE/authz flows,
all of which are non-goals; a dependency with an auth-flow surface we must
not expose is negative value here.

### 7B.4 Probes (before implementation)

- **Probe 52 (hosted, live)** — `scratch/52-mcp-oauth-hosted-probe`:
  mcp_oauth credential CRUD wire shapes (readable `auth` subset on
  create/get/list — the M3 blind spot; update-merge semantics on the
  `refresh` block; structural immutability of `token_endpoint`/`client_id`
  → expected 400); `mcp_oauth_validate` response field set for a bogus
  credential (captures `invalid`/`unknown` + `mcp_probe`/`refresh` shapes
  live; `has_refresh_token` both ways; the `?beta=true` query quirk from
  the docs curl example); validate called on a `static_bearer` credential.
  A `valid` capture needs a real OAuth grant — best-effort (skip if no
  grant is at hand; the shape evidence is the requirement).
- **No SDK probe needed** — M3 adds no new SDK surface (probe 49 already
  pinned `requestInit` headers + rejection codes). The OAuth token-endpoint
  fixture is a test fixture, not a probe: hermetic HTTP server implementing
  the refresh grant for all three `token_endpoint_auth` modes, token
  rotation, `expires_in`, `invalid_grant` 400, and 500/timeout modes.

### 7B.5 Testing (M3)

- **Refresh unit matrix** (token-endpoint fixture): all three auth modes
  (Basic header vs body secret vs none), refresh-token rotation persisted
  atomically with the new access token (assert one transaction: inject a
  metadata failure → old tokens still resolve), `expires_in` → computed
  `expires_at`, missing `expires_in` → long-lived policy, `invalid_grant`
  → `refresh_status=invalid` + lazy-skip behavior, 500 → transient +
  backoff schedule written.
- **Lazy layer**: expired credential + dial → refresh happens in-path →
  connect fixture observes the NEW token; single-flight (two concurrent
  dials, fixture sees exactly one refresh POST); `invalid` status →
  no refresh attempt, stale token injected, auth-failed event flows
  (existing M2 machinery).
- **Ticker layer**: due row refreshed without any dial; backoff on 5xx
  (next_refresh_at advances, attempts increments); invalid → proactive
  stops; credential update clears status + reschedules; restart recompute
  (new store instance → correct next wake with no event replay);
  `OMA_ENABLE_MCP` off → loop never starts (no token-endpoint egress);
  wake-loop unit tests (next-wake ordering, close() cancels, onError
  doesn't kill the loop).
- **Fingerprint propagation**: refresh bumps `updated_at` → exhausted
  budget resets and the next operation redials with the refreshed token
  (M2's rotation test extended to refresh-driven rotation).
- **Wire matrix** (vaults-api): mcp_oauth create/rotate round-trips;
  write-only fields (`access_token`, `refresh_token`, `client_secret`)
  never in any serialized response; structural immutability
  (`token_endpoint`, `client_id`, `mcp_server_url`) → 400; refresh-block
  merge update; validate endpoint statuses (valid via fixture, invalid,
  unknown, no_refresh_token, static_bearer-called → probe-52-pinned
  shape); `rotateMasterKey` rewraps the JSON secret row.
- **Leak sweep**: refresh_token/client_secret absent from all persisted
  events, API responses, and captured logs across a refresh cycle
  (extends the M2 echoing-401 regression to the token-endpoint legs:
  fixture echoes the refresh_token in an error body → asserted absent
  from the persisted validation/error surfaces).
- **Live-style smoke** (`scratch/53-mcp-oauth-live-smoke.ts`, smoke-51
  recipe): full stack, real model turn — OAuth token-endpoint fixture +
  bearer-checking MCP fixture; session dials with a pre-expired access
  token → lazy refresh → tool call succeeds → sweep proves no secret
  material in events; then rotate at the fixture and prove the next
  operation uses the rotated token.

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

### 7B.8 Open questions (probe 52 / review)

1. Readable `auth` subset for mcp_oauth credential responses — probe 52.
2. `mcp_oauth_validate` on a `static_bearer` credential — probe 52
   (interim: 400).
3. Whether hosted requires `expires_at` on create when a `refresh` block
   is present (docs example always includes it) — probe 52; interim:
   required with `refresh`, optional without (treat absent as long-lived).
4. `validated_at`/probe ordering fields in the validation object under a
   `valid` outcome — probe 52 best-effort (needs a live grant).

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
