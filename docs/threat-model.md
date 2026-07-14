# Threat model

**Status:** Partially filled. Sections 1 (tenant boundary), 7 (authentication),
and 8 (denial of service) describe shipped mechanisms as of plan 0113 (#129,
2026-07). Sections 2-6 remain open questions to be answered before any
deployment that handles real tenant data or runs untrusted prompts. For the
trusted single-node scope, the threat model is "Docker-local contains sandbox
execution; workspace auth + admission limits contain the API surface;
everything else is trust-the-operator."

This doc originally existed as a stub so the threat-model gap couldn't be
silently overlooked (code-review finding MEDIUM 7).

Deployment-mode terminology and sequencing are defined in
[0103 - Deployment Hardening](plans/0103-deployment-hardening.md).

---

## Categories

### 1. Tenant boundary

**Question to answer:** How are sessions isolated between tenants (when multi-tenant)?

**Answered (plan 0113, #129):**

- Workspaces map to API keys (`workspaces` + `workspace_api_keys` tables in the
  durable SQLite store). Sessions, agents, events, files, idempotency keys, and
  recovery sweeps are all workspace-scoped: every store method takes a
  `WorkspaceId` and every SQL query filters on `workspace_id`.
- The workspace ID is **never** taken from a request header. It is derived
  server-side by the auth middleware from the authenticated `x-api-key`
  (`src/control-plane/app.ts`), then read by routes via `workspaceIdFrom(c)`.
  There is no client-controllable workspace selector.
- Session/event IDs are not signed, and don't need to be for tenancy: a guessed
  ID from another workspace returns the same 404 envelope as a nonexistent ID
  (no existence leak). Cross-workspace denial is covered by tests in
  `src/control-plane/__tests__/workspace-auth-api.test.ts`.
- Still open (post-single-node): sandbox providers beyond Docker-local must
  keep their session→container maps workspace-scoped; revisit when a remote
  provider (e.g. Modal) is wired in.

### 2. Host-escape assumptions

**Question to answer:** What containment does the sandbox provide, and what assumes we don't have?

- Current Docker-local path: sandbox containers run without the Docker socket,
  with `--network none`, `--read-only`, dropped capabilities,
  `no-new-privileges`, tmpfs workspace/uploads/outputs mounts, memory/PID/CPU
  limits, and a non-root uid/gid. These are load-bearing for local isolation.
- The Docker socket must not be mounted into sandbox containers.
- A future Docker Compose setup that mounts the Docker socket into the
  control-plane container is a dev-only host-control shortcut, not a production
  deployment shape.
- `host-passthrough` is not a sandbox. It executes agent-directed shell/file
  operations on the host filesystem under an explicitly configured workspace
  root. It is acceptable only for trusted local tests behind unsafe env gates.
- Future Modal Sandboxes may provide a stronger remote isolation boundary, but
  Modal is not the current deployed provider.
- We do NOT assume: full hardware-level isolation, perfect side-channel
  resistance, protection against denial-of-service via runaway loops, or live
  compute continuation after a Docker-local worker/container dies.
- Open: what's our sandbox-escape incident response plan? For Docker-local
  dev/demo, the likely action is terminate the labelled container, mark the
  session terminated, and alert the operator.

### 3. Network egress

**Question to answer:** Where can a sandbox connect, and how do we enforce that?

- Current Docker-local path: sandbox containers use `--network none`.
- Host-passthrough has host network access because it is host execution, not a
  sandbox. Do not use it for untrusted prompts.
- Future remote providers need an explicit egress decision. Per-session egress
  allowlists should map to Managed Agents'
  `environment.config.networking: { type: "limited", allowed_hosts: [...] }`.
- Threat: prompt injection that exfiltrates context to attacker-controlled domain via `web_fetch` or `bash` curl. Mitigation: egress allowlist + secret-free sandbox (see §4).
- **Design decided ([ADR 0016](adrs/0016-egress-proxy-and-secret-injection.md), accepted 2026-07): OMA-owned egress proxy (vendored srt stack) with default-deny allowlist, per-request path policy, and redirect re-evaluation — the proxy mechanism (incl. the `filterRequest` path-deny branch and verify-before-inject) validated for proxy-honoring clients in probe 44. Caveats the probe made explicit: path policy/injection apply only to terminated TLS (opaque tunnels bypass them); the private-IP/SSRF deny is OMA's to add and must connect-to-pinned-IP to resist DNS rebinding (probe 44 confirmed srt has none); and route-level confinement (proxy-only egress, so a non-compliant client can't bypass) is implementation work, not yet proven. Not yet built.**

- **Control-plane MCP dials (0122 M1, shipped 2026-07-07): a second egress
  class, distinct from sandbox egress.** Agent configs carry
  attacker-influenceable `mcp_servers[].url` values and the control plane
  dials them directly (streamable HTTP). Mitigations, all tested: pinned-DNS
  deny of private/loopback/link-local/reserved ranges re-checked on every
  resolution (rebinding-safe, `egress/ssrf.ts` reused), explicit IP-literal
  pre-check (Node skips the lookup seam for literals), forced
  `redirect: "error"`, embedded-userinfo URLs rejected at agent validation,
  and the deployment gate `OMA_ENABLE_MCP` (default off). Credentials do not
  exist in this path until M2; when they arrive they are injected
  control-plane-side and never enter the sandbox or the event stream.

### 4. Secret injection paths

**Question to answer:** What credentials/secrets can a sandbox observe?

- **Explicit non-goal:** sandbox MUST NOT have access to user-controlled credentials beyond what's required for its declared tools. See ADR 0005 — custom tools execute on the orchestrator (control plane), not in the sandbox.
- **MVP boundary:** `ANTHROPIC_API_KEY` is on the control-plane host, never in the sandbox. The sandbox container's env is minimal (PATH, HOME, locale).
- **Design decided ([ADR 0016](adrs/0016-egress-proxy-and-secret-injection.md), accepted 2026-07): secrets are envelope-encrypted in OMA's SQLite behind a `SecretsStore` interface (AES-256-GCM per-secret DEK, master KEK from `OMA_MASTER_KEY`/file); the sandbox holds only sentinels and the egress proxy injects the real value at the boundary. Proven in probe 45. This is the #130 ruling — OMA-level boundary injection, not provider-carried. Not yet built.**
- Open (bounded by ADR 0016): GitHub repo `authorization_token` for repo mounts, and MCP OAuth credentials — both flow through `SecretsStore` + boundary injection; the remaining work is per-provider wiring, not the design.
- Residual (ADR 0016 §6): a reflective allowlisted upstream can echo an injected secret back into the sandbox; v1 mitigation is allowlist trust, with response redaction deferred.

### 5. Log redaction

**Question to answer:** What appears in logs, and how do we keep secrets out of them?

**Decided (plan [0121](plans/0121-observability.md) §3.4, implemented in C1).**
The former open bullets split across two channels with different answers:

- **Log channel — closed, programmatically.** Every control-plane log line
  goes through `src/control-plane/logging.ts`, which enforces redaction at
  emit time rather than by review convention:
  - *R1 — logs carry identifiers and classifications, never content or
    credentials.* A field denylist replaces content-bearing keys
    (`message`/`text`/`prompt`/`content`/`input`/`output`/`body`/
    `authorization`, matched per name segment so compound keys like
    `tool_output`/`errorMessage` are caught, plus any key matching
    `*key*`/`*secret*`/`*token*`/`*password*` — digest **suffixes** like
    `key_sha256` excepted; `password_hash`-style names stay denied) with
    `"[redacted]"` before serialization.
  - *R2 — error messages are the leak channel.* Error values serialize to
    `{name, message}` (plus one level of scrubbed `cause`) where the
    message — and every other string value — first passes a secret
    scrubber: `oma_…` API keys, 32-byte-base64 key shapes, credential
    header/env assignments (whole value, including `Bearer`/`Basic` scheme
    forms and `Proxy-Authorization`), common foreign shapes (`sk-…`,
    GitHub `gh?_…`, JWTs, AWS `AKIA…`), and credential-bearing URL query
    params — then a 1 KB cap. Stack traces are omitted unless
    `OMA_LOG_STACKS=1` (and are scrubbed when present). Tests assert
    planted secrets are **absent** from output, not merely truncated; the
    scrubber is pattern-based, so novel secret formats can pass — sites
    handling known-sensitive material must log classifications, not
    messages.
  - `admin_audit` events are emitted at a dedicated `audit` level that
    bypasses `OMA_LOG_LEVEL`: diagnostic verbosity settings cannot silence
    the admin audit trail. (The `oma` CLI's Node-version guard is a separate
    pre-boot process and prints one plain error line by
    necessity; it carries no tenant data or secrets.)
- **Persist/stream channel — deliberately verbatim (R3).** Session
  transcripts and tool outputs are the product; scrubbing them would break
  replay and wire parity, so persistence-layer content redaction is
  **deferred** for the single-node trusted-operator tier (0112). Two
  residuals are named, not papered over: (a) the asymmetry with 0118 —
  secrets are encrypted at rest, yet a secret *echoed into session content*
  (e.g. a tool printing an env var) persists in cleartext SQLite; (b) this
  is the same residual as ADR-0016 §6's deferred response-redaction item.
  Both revisit together when the deployment tier changes
  (managed/multi-tenant).

### 6. Sandbox teardown

**Question to answer:** When does a sandbox get destroyed, and what state survives?

- Current Docker-local path: one sandbox container is tied to a live session
  handle. It is disposed on explicit close/delete, runner close, and idle
  eviction. A startup stale-container sweep exists for labelled Docker-local
  containers.
- Current demo storage is in-memory. If the control plane restarts, live
  sandbox state is not durable. Docker-local tmpfs workspace/output state is not
  a resumable compute context.
- Intended next target: single-node durable metadata and local object storage.
  This preserves control-plane state across restart, but still does not promise
  continuation of a killed in-container process.
- Future multi-worker target: workers may terminalize or restart future work
  after a crash; they must not claim to continue the same Docker-local tmpfs
  compute context.
- Open: persistent state across sandbox restarts? MVP says no (ephemeral);
  future memory-store work changes this.

### 7. Authentication & authorization

**Question to answer:** Who can call what?

**Answered (plan 0113, #129):**

- Per-workspace API keys: opaque `oma_`-prefixed 256-bit bearer keys in the
  `x-api-key` header, SHA-256 digests at rest (never plaintext — deterministic
  hash is correct for 256-bit random secrets), minted/revoked via the operator
  CLI (`scripts/oma-workspaces.ts`, see `docs/dev-deployment.md`).
- Fail-closed modes: `OMA_AUTH_MODE=api-key` enforces auth and refuses to start
  without durable storage; `disabled` is explicit; unset warns loudly and
  resolves everything to `wrk_default`; any other value refuses to start.
  `api-key` is required for any deployment beyond trusted single-node.
- Auth failures return the hosted-identical generic 401 ("Authentication
  failed") for missing, malformed, and revoked keys alike — no key-existence
  leak. Wire shapes verified against the hosted API
  (`scratch/0113-hosted-auth-wire-probe.md`).
- Revocation is a tombstone (`revoked_at`); it gates new requests only. A live
  SSE stream opened before revocation runs until disconnect; restart severs it.
- ID signing: not needed for tenancy (see §1) — all lookups are
  workspace-scoped server-side.
- Still open: RBAC within a workspace (create vs. read roles). All keys in a
  workspace currently have full access to that workspace.

### 8. Denial of service

**Question to answer:** What stops a single session from monopolizing resources?

**Partially answered (plan 0113 D9, #129):**

- Per-workspace admission limits exist and are bound to authenticated workspace
  identity (the precondition the stub demanded): max active sessions, max
  pending runtime turns, max concurrent uploads (per-workspace and global), max
  concurrent SSE streams (per-workspace and global) — all via `OMA_MAX_*` env
  vars (`src/control-plane/admission.ts`, documented in
  `docs/dev-deployment.md`). Rejections are hosted-shaped 429
  (`rate_limit_error`, `retry-after: 1`) / 529 (`overloaded_error`). Gates sit
  before the expensive work; the two subtle placements (session cap reserving
  before async file-resource prep, upload cap rejecting without draining the
  body) are verified in
  `src/control-plane/__tests__/admission-limits-api.test.ts`, and exact cap
  adherence under 20-way concurrency in
  `scratch/43-admission-limits-load.ts`.
- Counters are in-process: sufficient for single-node, not for multi-worker
  (needs shared state — see plan 0112 gate table).
- Per-container memory/PID/CPU/operation/output limits exist on the
  Docker-local path.
- Open: max concurrent sandboxes per process and per workspace (admission caps
  bound sessions, not sandbox containers directly).
- Open: max sandbox runtime per session (kill switch).
- Open: max token-budget per session (Anthropic's `task_budgets` analogue).
- Open: max event-log size per session (10MB? 100MB?).

---

## When to revisit

- Before *any* multi-tenant deployment.
- Before exposing the control plane to untrusted users (including "trusted-but-curious" users).
- Before integrating vaults (0122 M2) / GitHub repo mounts (each adds a new secret category). MCP *execution* integrated 2026-07-07 (0122 M1, §3) — credential-free by scope.
- After any incident — even one that didn't actually exploit anything.
