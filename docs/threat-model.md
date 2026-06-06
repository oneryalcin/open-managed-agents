# Threat model (stub)

**Status:** Stub. Sections listed below are placeholders to be filled in before
any deployment that handles real tenant data or runs untrusted prompts. For the
MVP scope (single developer, single tenant, single trusted user), the threat
model is "Docker-local contains sandbox execution for the current dev/demo
path; everything else is trust-the-operator."

This doc exists primarily so the threat-model gap can't be silently overlooked — see code-review finding MEDIUM 7.

Deployment-mode terminology and sequencing are defined in
[0103 - Deployment Hardening](plans/0103-deployment-hardening.md).

---

## Categories

### 1. Tenant boundary

**Question to answer:** How are sessions isolated between tenants (when multi-tenant)?

- MVP: single workspace, single user, no tenancy. Skip.
- Post-MVP: workspaces map to API keys. Pi sessions, SQLite rows, Modal sandboxes, pending-call maps must all be workspace-scoped.
- Open: do we trust the workspace ID in the auth header, or sign session IDs to prevent cross-workspace session-ID guessing?

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

### 4. Secret injection paths

**Question to answer:** What credentials/secrets can a sandbox observe?

- **Explicit non-goal:** sandbox MUST NOT have access to user-controlled credentials beyond what's required for its declared tools. See ADR 0005 — custom tools execute on the orchestrator (control plane), not in the sandbox.
- **MVP boundary:** `ANTHROPIC_API_KEY` is on the control-plane host, never in the sandbox. The sandbox container's env is minimal (PATH, HOME, locale).
- Open: GitHub repo `authorization_token` — when we add repo mounts (post-MVP), how does the git proxy inject auth? Mirror Anthropic's design (out-of-band injection by an Anthropic-side proxy) — never put the token in the container.
- Open: MCP credentials (post-MVP) — design vault to mirror Anthropic's auto-refreshing OAuth model. Never expose to the container.

### 5. Log redaction

**Question to answer:** What appears in logs, and how do we keep secrets out of them?

- Open: do prompts/responses get logged? At MVP scale (single user, debug-level logging), yes; at scale, this is a privacy/secret-leakage risk.
- Open: tool outputs may contain secrets (e.g., a bash command that prints an env var). Mitigation: configurable redaction in event persistence layer (regex over `text` content blocks before SQLite insert?).
- Open: error stack traces from `Tool.execute()` shouldn't include user input. Sanitize before persisting/streaming.

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

- MVP: TBD — likely a single shared bearer token in `.env`. Acceptable for solo experiment.
- Post-MVP: per-workspace API keys, RBAC for environment/agent create vs. read,
  and authenticated workspace identity for any per-workspace admission limits.
- Open: do we sign session IDs / event IDs to prevent guessing? Probably yes once multi-tenant.

### 8. Denial of service

**Question to answer:** What stops a single session from monopolizing resources?

- Current Docker-local path has per-container memory/PID/CPU/operation/output
  limits, but no global admission controller.
- Open: max concurrent sandboxes per process and per authenticated workspace.
- Open: max sandbox runtime per session (kill switch).
- Open: max token-budget per session (Anthropic's `task_budgets` analogue).
- Open: max event-log size per session (10MB? 100MB?).
- Do not treat per-workspace admission limits as security controls until
  workspace identity is authenticated. Header-trusted workspace selection is
  only acceptable for local/trusted modes.

---

## When to revisit

- Before *any* multi-tenant deployment.
- Before exposing the control plane to untrusted users (including "trusted-but-curious" users).
- Before integrating MCP / vaults / GitHub repo mounts (each adds a new secret category).
- After any incident — even one that didn't actually exploit anything.
