# ADR 0016: Egress proxy and boundary secret injection

**Status:** Accepted, 2026-07-02

## Context

Sandboxed agents today run under `--network none` (ADR 0003, threat model §2).
That is an honest isolation posture but also a capability ceiling: no
`web_fetch`, no package installs, no API-calling agents, and no path to
skills or MCP servers that need the network. The hosted product solves this
with per-environment egress allowlists
(`environment.config.networking: { type: "limited", allowed_hosts: [...] }`)
plus an egress proxy that injects credentials so **secrets never enter the
sandbox** — the "use without read" model.

This ADR decides how OMA provides the same capability. It is the keystone for
the 0114 capability track: egress unlocks skills, MCP, and web tools, and the
same boundary does secret injection. It closes the two threat-model open items
§3 (network egress) and §4 (secret injection paths), and resolves tracking
issue #130 (provider-carried secret proxy vs. OMA-level boundary injection).

The design was chosen by a source-verified buy-vs-build survey
([egress-secrets-buy-vs-build.md](../references/egress-secrets-buy-vs-build.md))
and then de-risked by two confidence probes before this ADR was written:

- **Probe 44** (`scratch/44-egress-proxy-probe.ts`): drove Anthropic's
  `sandbox-runtime` (srt) proxy stack against a real Docker container and
  proved (enforcement checks) hostname-allowlist denial (403), per-request
  path-policy denial via `filterRequest`, redirect re-evaluation, per-session
  proxy auth (407), sentinel→real substitution with only the sentinel in the
  container's environment, and verify-before-inject (a wrong upstream CA fails
  and the secret never leaves). Confirmed *absent*: any private-IP/SSRF deny.
- **Probe 45** (`scratch/45-envelope-encryption-probe.ts`): proved the secrets
  envelope in `node:crypto` alone — per-secret DEK, master-KEK wrap, AAD
  record-binding on both layers (mutation-verified load-bearing), truncated-tag
  rejection, and rotation that leaves ciphertext untouched.

## Decision

### 1. OMA owns the egress boundary; the proxy core is vendored, not built or depended on

OMA runs its own egress proxy. The proxy **core is vendored** from srt's
proxy stack (`http-proxy`, `tls-terminate-proxy`, `mitm-ca`, `request-filter`,
~1,250 LOC, Apache-2.0), not taken as a dependency: srt does not export
`createHttpProxyServer`, has no `exports` map, and self-labels as a research
preview (probe 44 confirmed the deep `dist/` import works but is unsupported).
Vendoring lets us adopt a working implementation and track upstream rather than
lean on an unstable API or reimplement TLS-termination hygiene ourselves.
Caveat we own (Consequences): srt is upstream-labelled a research preview and
we are not citing an independent security audit; vendoring forfeits npm
advisories, so every upstream release must be hand-diffed against our vendored
copy on a committed cadence, and the code needs its own review before it is a
production security boundary.

We reject provider-carried secret substitution (microsandbox's built-in
proxy): #121/#130 could never prove it end-to-end, and OMA-owned injection
works identically across Docker-local and microsandbox-local. **This is the
explicit #130 ruling: provider secret proxy is out of scope; OMA-level
boundary injection is the design.**

### 2. Egress policy is data, resolved by the control plane

A session's egress policy is a plain serializable object — allowlist entries
(host, optional path prefix) and credential grants (sentinel → secret
reference + inject hosts) — derived by the control plane from the
authenticated workspace and the session's environment, and handed to the
proxy through a narrow module boundary. Policy is testable without a running
proxy and maps directly onto hosted `environment.config.networking`. We adopt
the hosted allowlist *mechanism* but keep OMA's **default-deny** posture: an
environment with no networking config **stays at `--network none`** — no proxy
is stood up at all, so there is no egress even if the vendored proxy has a bug.
The proxy exists only for environments that explicitly grant egress.

### 3. Secrets never enter the sandbox; the proxy injects at the boundary

The sandbox holds only per-session **sentinels**. On an outbound request to a
declared inject-host, the proxy substitutes the real secret (probe 44's
`mutateHeaders` path), with the upstream TLS leg cert-verified before any
mutated bytes leave. TLS termination requires the per-session MITM CA in the
sandbox trust bundle (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`,
pip/curl equivalents), with a per-host termination opt-out for cert-pinned /
mTLS upstreams. The sandbox network shape changes from `--network none` to
**proxy-only egress** (an internal network whose sole route is the proxy),
so the proxy is a wall, not an env-var honor system. (Probe 44 did not prove
this — it used a proxy-honoring client on default networking; an
implementation-slice test must assert that a client with proxy env removed /
using raw sockets cannot egress directly.)

**Coverage boundary — path policy and injection are TLS-only.** srt falls back
to an *opaque byte tunnel* (no `filterRequest`, no path policy, no injection)
for two cases: a per-host TLS-termination opt-out (§ cert-pinned/mTLS above),
and any CONNECT whose first bytes are not a TLS ClientHello. An allowlisted
host:port therefore grants the sandbox a raw-TCP channel that policy does not
inspect. v1 **rejects non-TLS CONNECT payloads** unless the host is explicitly
flagged for opaque tunnelling, and documents that path/method policy and
injection are guarantees only for terminated TLS.

### 4. Secrets are envelope-encrypted in OMA's SQLite behind a `SecretsStore` interface

No vault dependency. Per probe 45: each secret is encrypted under a random
per-secret DEK (AES-256-GCM); the DEK is wrapped by a KEK derived
`HKDF-SHA256(masterSecret, info="oma-kek:<kekId>")`; both layers bind an AAD
(`<version>:<recordId>` on the ciphertext, `<version>:<kekId>:<recordId>` on
the wrap) to prevent cross-record swaps. Persisted fields:
`version, kekId, wrapIv, wrapTag, wrappedDek, ctIv, ctTag, ct`.

**Two hardening requirements the probe surfaced, mandatory in the store:**

- **Pin `authTagLength: 16`** on every `createDecipheriv` and reject any tag
  whose length ≠ 16. `node:crypto` otherwise *accepts a truncated tag* (probe
  45 (6b) verified a 4-byte tag decrypts with only a deprecation warning),
  degrading forgery resistance from 2^128 to 2^32 — and the tag is an
  attacker-writable DB column.
- **Pin the master-key format**: exactly 32 random bytes (e.g. base64), refuse
  anything else. HKDF is not a password KDF; a low-entropy passphrase in
  `OMA_MASTER_KEY` would make the DB offline-brute-forceable. If passphrases are
  ever wanted, route them through scrypt first — a separate, explicit contract.

Decisive rationale from the survey: OpenBao's own single-node static auto-unseal
reads its master key from env/file — cryptographically the same trust model — so
a vault sidecar adds operational weight without a stronger root of trust on one
machine. OAuth refresh uses the MCP TS SDK / `openid-client`; tokens are
re-encrypted on refresh.

**What this encryption defends, stated honestly (do not overclaim):** it
protects **DB-file-only** exfiltration — stolen backups, a leaked SQLite file,
misconfigured file perms. It does **not** defend host compromise: `OMA_MASTER_KEY`
lives in the process environment on the same host as the database, so an
attacker with host access gets both. And rotation (probe 45 (7c)) only stops the
retired master from opening the *rewrapped* row going forward — it does **not**
recover from a master key that leaked alongside a pre-rotation DB copy (that
copy decrypts forever), and because `ct` is never re-encrypted, a once-leaked
DEK is a permanent decrypt capability for its record. Rotation limits blast
radius; it is not revocation.

### 5. Add an SSRF/private-IP deny that connects to the vetted IP (not the hostname)

Probe 44 confirmed srt has **no** SSRF defense: an allowlisted loopback target
was served. OMA must add one — but a naive "resolve, check the IP, then let srt
dial the hostname" is **check-then-connect and does not stop DNS rebinding**:
srt's upstream leg dials by hostname (it re-resolves), so an attacker who
controls an allowlisted domain can flip the A record between our check and the
dial (TOCTOU). The fix, as smokescreen does it, is **resolve once, validate the
resolved IP(s) against the private/loopback/link-local/ULA blocklist, then
connect to that pinned IP** with the hostname preserved only as TLS `servername`
/ SNI — handling multiple A records and IPv6. This touches the vendored dial
path, not just the policy layer, so it is more than the "~50 lines" a
filter-only check would be.

**Implemented in two halves** (plan 0117b; review found the second is
essential): (a) *DNS names* go through the pinned `lookup` above, wired to
every upstream dial (CONNECT-terminated, plain-HTTP direct, opaque-tunnel);
(b) *IP literals* — Node structurally skips the `lookup` hook for numeric
hosts, so a literal like `169.254.169.254` would bypass (a) entirely. The
literal half is enforced by wrapping the caller's `filter` (which runs before
every dial on both handlers) to reject any host that is a blocked IP literal.
The blocklist also denies IPv6 forms that embed a private IPv4 (IPv4-mapped,
NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, Teredo `2001::/32`), since those could
reach private space through a transition gateway while looking public.

**Safe by construction, enforced at the public surface** (review-driven): the
`createEgressProxy` option type removes the vendor settings that would route a
dial around this deny — `lookup` (a caller resolver would replace the validating
one) and `getMitmSocketPath` (an external MITM route dials outside the check) —
and the constructor rejects them at runtime too. The pinned lookup is applied
*after* caller options so it cannot be overridden. The only relaxation is a
loudly-named test flag (`dangerouslyAllowPrivateAddressesForTest`) for in-process
loopback fixtures; the literal filter-wrap runs regardless of it.

### 6. Response redaction is deferred but named

Boundary injection cannot hide a secret from a *reflective* allowlisted
upstream: srt pipes responses back unmodified, so an upstream that echoes the
injected header returns the secret into the sandbox (probe 44 (d3),
by design). Reflectivity is a **per-endpoint** property, not per-host — one
debug route or header-echoing error page on an otherwise-trusted inject-host
leaks the secret, and a host-level inject grant lets the agent steer requests
to that endpoint. So v1 does NOT rely on host-granularity "trust": **inject
grants must be path/method-scoped** (the policy's credential-grant entries
already carry an optional path prefix — require it for inject-hosts), and
reflection vetting is stated as per-endpoint. Response redaction (Osaurus's
output scrubbing is the prior art,
[agentos-osaurus-prior-art.md](../references/agentos-osaurus-prior-art.md)) is a
stronger later mitigation, deferred past v1.

### 7. Modularity: keep the named seams, refuse the speculative registries

Per the 0114 modularity rule (interface when the second implementation is
*named*, not merely imaginable):

- **Keep** the `SecretsStore` interface (SQLite now; OpenBao/KMS-backed named
  for SaaS) and the **KEK-wrap function** as its own seam — the single point
  where env-key wrapping becomes KMS/transit wrapping (probe 45 (7) proved the
  rotation seam).
- **Keep** egress policy as data behind a narrow proxy module boundary.
- **Refuse** an `EgressProxyProvider` registry and a generic vault-plugin
  system: one proxy implementation (vendored srt), no named second; a swap
  replaces one module behind the policy contract. Building swap machinery now
  is the ResourceManager mistake (file-storage prior art).

## Rejected alternatives

| Option | Why not |
|---|---|
| Provider-carried secret proxy (microsandbox) | Never proven end-to-end (#121/#130); provider-specific; OMA-owned works across providers. **Explicitly ruled out here.** |
| Infisical `agent-vault` (off-the-shelf service) | Purpose-built and tempting, but 3 months old, fail-open for unmatched hosts by default, and brings a vault/UI surface OMA doesn't need — too much trust in young code at the most security-critical seam. Re-evaluate if it matures. |
| mockttp as the proxy | Proven MITM core, but 47 deps and we'd re-write srt's probed details — URL-parser-differential closure and verify-before-inject (probe 44 (g)) — that srt already implements. |
| mitmproxy / OpenSandbox sidecar | Full Python runtime in a Node appliance / Linux-only + `CAP_NET_ADMIN` + one sidecar per sandbox. |
| HashiCorp Vault | BSL license — redistribution liability in a self-hostable product. |
| OpenBao now | MPL and viable, but same env-key trust model on one node; adopt later as the `SecretsStore` SaaS backend, not now. |
| Keep `--network none` | The capability ceiling this ADR exists to lift. |

## Consequences

- Skills, MCP, and web-capable agents become buildable — this ADR is their
  precondition.
- OMA takes on a security-critical component (the proxy) as vendored code:
  we own upstream-tracking and the private-IP check, and must keep the
  reflective-upstream caveat visible in operator docs.
- Operators gain `OMA_MASTER_KEY` as a new required secret for any deployment
  using credential grants; losing it makes stored secrets unrecoverable
  (documented, same class as any encryption key).
- The sandbox network wiring changes per provider (Docker network + trust
  bundle); microsandbox-local's no-secret posture (#130) can be revisited
  once this lands.

## Implementation status

Design accepted; not yet built. Foundations proven (probes 44, 45). Next
slices, each its own PR: vendor the proxy stack + private-IP deny;
`SqliteSecretsStore` + `SecretsStore` interface; egress-policy resolution and
proxy wiring into the Docker provider; then skills, then MCP on top.

## Open questions

- Exact `environment.config.networking` parse surface vs. hosted (re-probe
  before implementing, per house discipline).
- Where response redaction lands if/when v1's allowlist-trust proves
  insufficient.
- Per-provider trust-bundle injection details (Docker vs. microsandbox).

## Validation

- Probe 44 (egress proxy, 8 enforcement checks + 2 documented NOTES) and probe
  45 (secrets envelope, 11 checks), both deterministic, both with process notes
  and mutation checks on the load-bearing assertions. These are the evidence
  base; the implementation slices will carry their own contract tests.
- **What probe 44 does NOT prove** (review-driven, do not overread): it
  validates the proxy's policy/injection behavior for a *proxy-honoring*
  client, and its deny checks assert the explicit 403/407 the policy branch
  emits. It does NOT prove route-level confinement — the container uses default
  networking, so §3's "proxy-only egress" is a design commitment to be
  validated by an implementation-slice test that asserts a client with proxy
  env removed / using raw sockets cannot egress directly. Likewise the
  private-IP deny (§5) is confirmed *absent* in srt by probe 44, not present;
  it is OMA's to add and test.
