# Threat model (stub)

**Status:** Stub. Sections listed below are placeholders to be filled in before any deployment that handles real tenant data or runs untrusted prompts. For the MVP scope (single developer, single tenant, single trusted user), the threat model is "Modal handles container isolation; everything else is trust-the-operator."

This doc exists primarily so the threat-model gap can't be silently overlooked — see code-review finding MEDIUM 7.

---

## Categories

### 1. Tenant boundary

**Question to answer:** How are sessions isolated between tenants (when multi-tenant)?

- MVP: single workspace, single user, no tenancy. Skip.
- Post-MVP: workspaces map to API keys. Pi sessions, SQLite rows, Modal sandboxes, pending-call maps must all be workspace-scoped.
- Open: do we trust the workspace ID in the auth header, or sign session IDs to prevent cross-workspace session-ID guessing?

### 2. Host-escape assumptions

**Question to answer:** What containment does the sandbox provide, and what assumes we don't have?

- Modal Sandboxes provide gVisor-style container isolation by default — kernel-level boundary, separate filesystem, no host shell access. Document this as load-bearing.
- We do NOT assume: full hardware-level isolation (Modal sandboxes share infrastructure), perfect side-channel resistance, protection against denial-of-service via runaway loops (we'll need timeouts).
- Open: what's our sandbox-escape incident response plan? (Probably: terminate via Modal API, mark session terminated, alert.)

### 3. Network egress

**Question to answer:** Where can a sandbox connect, and how do we enforce that?

- MVP: unrestricted egress from sandboxes (Modal default). Document this prominently.
- Post-MVP: per-session egress allowlist passed through to Modal. Maps to Managed Agents' `environment.config.networking: { type: "limited", allowed_hosts: [...] }`.
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

- MVP: sandbox destroyed when session ends (`session.status_terminated`, explicit delete, or timeout).
- Open: what's the session-idle timeout? (Cost-bearing — Modal bills per second.) Recommendation: 1 hour idle → terminate sandbox, mark session needs-resume.
- Open: persistent state across sandbox restarts? MVP says no (ephemeral); future memory-store work changes this.
- Open: what guarantees teardown actually runs? A crashed control plane leaves orphan Modal sandboxes. Mitigation: Modal-side TTL on sandboxes, periodic reconciliation sweep.

### 7. Authentication & authorization

**Question to answer:** Who can call what?

- MVP: TBD — likely a single shared bearer token in `.env`. Acceptable for solo experiment.
- Post-MVP: per-workspace API keys, RBAC for environment/agent create vs. read, rate limits per workspace.
- Open: do we sign session IDs / event IDs to prevent guessing? Probably yes once multi-tenant.

### 8. Denial of service

**Question to answer:** What stops a single session from monopolizing resources?

- Open: max concurrent sandboxes per workspace.
- Open: max sandbox runtime per session (kill switch).
- Open: max token-budget per session (Anthropic's `task_budgets` analogue).
- Open: max event-log size per session (10MB? 100MB?).

---

## When to revisit

- Before *any* multi-tenant deployment.
- Before exposing the control plane to untrusted users (including "trusted-but-curious" users).
- Before integrating MCP / vaults / GitHub repo mounts (each adds a new secret category).
- After any incident — even one that didn't actually exploit anything.
