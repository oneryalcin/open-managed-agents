# Egress proxy and secrets storage: buy-vs-build survey

Date: 2026-07-02

Purpose: record the research behind OMA's egress-boundary and secrets-storage
design before any ADR or implementation. The trigger was the product-direction
discussion after #129 closed: the egress proxy was identified as the single
keystone component for three arcs at once — network allowlists
([threat model §3](../threat-model.md)), boundary secret injection
([threat model §4](../threat-model.md), #130), and unlocking MCP servers /
skills / web tools for sandboxed agents. The question answered here: **which
existing open-source projects can we use instead of building from scratch —
for the egress proxy and for the secrets vault?**

This is not an ADR. It records candidates, what each covers, and why each was
adopted or rejected. Claims were verified against the actual repositories
(source reads via `gh api`, docs, licenses) on 2026-07-02, not recalled from
memory.

Related prior art already in-repo, which this survey extends:

- [just-bash-prior-art.md](just-bash-prior-art.md) — the allowlist +
  boundary-credential-injection reference shape ("the headline borrowable").
- [oma-implementations-prior-art.md](oma-implementations-prior-art.md) — the
  open-ma vault-proxy pattern.
- `scratch/0109-microsandbox-secret-decisive-probe.md` / #130 — the negative
  result that ruled out provider-carried secret substitution.
- [0106 sandbox provider landscape](../plans/0106-sandbox-provider-landscape.md)
  — first sighting of `sandbox-runtime`'s deny-by-default proxy.

## Requirements

1. **Default-deny egress** with per-session allowlists (host, ideally
   origin + path prefix), redirects re-evaluated against the allowlist per hop.
2. **Boundary credential injection**: the sandbox holds only per-session
   placeholders (sentinels); the proxy substitutes real secrets on the way out
   to declared hosts. Secrets never enter the sandbox — the
   [threat model §4](../threat-model.md) non-goal. This implies TLS
   termination (MITM with a per-session CA) for HTTPS targets.
3. **Appliance-compatible footprint**: OMA installs as a local npm package or
   docker compose. A single static binary sidecar is acceptable; a platform
   (Envoy control plane, Postgres+Redis stacks, k8s-only tooling) is not.

## Verdict

**Egress proxy: adopt, don't build the core.** Vendor the proxy stack from
Anthropic's `sandbox-runtime` (Apache-2.0, ~1,250 LOC, TypeScript) — it
matches all three requirements by design, including the sentinel→real
credential substitution model, and it is the machinery Anthropic itself runs
under Claude Code. Steal smokescreen's post-DNS-resolution private-IP deny
check (~50 lines) on top.

**Secrets storage: build thin, no vault dependency.** AES-256-GCM envelope
encryption inside OMA's existing SQLite — a random per-secret DEK wrapped by a
master KEK from env/file, `node:crypto` only — behind a small `SecretsStore`
interface whose KEK-wrap operation is the seam where OpenBao transit or a
cloud KMS plugs in later. The decisive argument: OpenBao's own single-node
static auto-unseal reads its master key from env/file, so a vault sidecar on
the same machine adds operational weight without adding a stronger root of
trust.

The two halves converge on one architecture, independently reproduced by
just-bash, open-ma's `oma-vault`, and hosted Gemini Managed Agents: **secrets
encrypted in the app's own store; sandbox sees sentinels; one proxy at the
egress boundary does allowlist enforcement and sentinel substitution.**

## Egress proxy candidates

### Adopted: Anthropic `sandbox-runtime` proxy stack (vendor)

Repository: [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
(npm `@anthropic-ai/sandbox-runtime`, v0.0.63 at review time).

- TypeScript (Node ≥ 20), Apache-2.0, ~4.5k stars, Anthropic PBC, actively
  pushed (same-day commits at review time). Runtime deps are tiny:
  `node-forge`, `@pondwader/socks5-server`, `commander`, `zod`.
- Verified in source (`src/sandbox/http-proxy.ts`, `tls-terminate-proxy.ts`,
  `mitm-ca.ts`, `request-filter.ts`, `sandbox-config.ts`):
  - `createHttpProxyServer()` takes a `filter(port, host)` allowlist callback
    plus `filterRequest` — a per-request callback that sees the full
    **decrypted** URL, so origin+path-prefix rules are ours to write;
  - TLS termination is ClientHello-sniffed (non-TLS CONNECT streams fall back
    to an opaque tunnel), with `shouldTerminateTLS` as a per-host opt-out for
    mTLS / cert-pinned targets;
  - `mutateHeaders` mutates on the terminated path with the upstream leg
    **cert-verified before mutated bytes leave**; plaintext-HTTP mutation is a
    separate explicit opt-in;
  - redirect safety falls out of the design: every post-redirect request
    re-enters `filterRequest`;
  - `proxyAuthToken` gives per-session bearer auth on the proxy itself (407
    otherwise) — the per-session policy key;
  - the credential model is literally requirement 2: `CredentialFileConfigSchema`
    mode `mask` replaces secrets in the sandbox with per-session sentinels and
    the host proxy substitutes sentinel→real on egress to `injectHosts`, with
    config-time validation that `injectHosts ⊆ allowedDomains` and warnings
    when TLS-termination exclusions would let traffic dodge injection;
  - the plain-HTTP path reconstructs the absolute URI from parsed components,
    closing URL-parser-differential bypasses.
- The proxies are plain localhost TCP listeners, so OMA's Docker sandboxes can
  use them via `HTTP_PROXY`/`HTTPS_PROXY` + the per-session auth token + the
  MITM CA in the container trust bundle. The bubblewrap/Seatbelt process
  sandbox — the other half of srt — is a different isolation tier than our
  Docker containers and is not needed.
- **Why vendor rather than depend**: `src/index.ts` does not export
  `createHttpProxyServer` (only `SandboxManager`, config schemas, and callback
  types), and `package.json` has no `exports` map — deep-importing `dist/` is
  unsupported API. The repo self-describes as a beta research preview and
  flags `tlsTerminate` experimental. Apache-2.0 permits vendoring the ~1,250
  LOC proxy stack (http-proxy 461 + tls-terminate 323 + mitm-ca 294 +
  request-filter 159 + parent-proxy/mitm-leaf); we adopt the code and track
  upstream rather than lean on a stability contract.
- Known limitation they document: env-var proxying can be ignored by
  non-conforming programs. OMA's containers close this: `--network none`
  except the proxy path means the proxy is the only route out, not an honor
  system.
- Strategic bonus: for a Managed Agents clone, matching upstream Anthropic's
  own egress semantics is a parity feature in itself.

### Runner-up: Infisical `agent-vault`

Repository: [Infisical/agent-vault](https://github.com/Infisical/agent-vault).

- Go, MIT, ~1.8k stars, company-backed, created ~Mar 2026 (three months old
  at review time). Purpose-built "HTTP credential proxy and vault for AI
  agents": MITM proxy substitutes dummy values (`__anthropic_api_key__`-style)
  on egress; orchestrator-minted short-lived per-sandbox tokens (their README
  use case is exactly OMA's shape); service rules filter egress down to
  specific API endpoints; single binary / one Docker image.
- Rejected for now: **default posture forwards unmatched hosts** (strict
  `unmatched_host_policy=deny` must be flipped — fail-open by default is the
  opposite of our posture); three months of history at the most
  security-critical seam; and it brings a vault/UI/multi-tenant admin surface
  OMA doesn't need. Worth a re-look if it matures and we want an off-the-shelf
  compose sidecar instead of owning proxy code.

### Fallback: mockttp

Repository: [httptoolkit/mockttp](https://github.com/httptoolkit/mockttp) (v4.4.2).

- TypeScript, Apache-2.0, maintained (powers HTTP Toolkit's proxy internals —
  production-grade, though the API is test-flavored). HTTPS interception with
  built-in CA generation; per-session policy = one in-process server per
  session on a dynamic port; default-deny = catch-all 403 rule; header rewrite
  and arbitrary `beforeRequest` callbacks verified in source.
- Rejected as first choice: 47 runtime dependencies (express, graphql, ws come
  along even unused), and we would re-write the security-sensitive details srt
  already got right (URL-differential closure, verify-before-inject ordering).
  Notable: open-ma's `oma-vault` is built on exactly this library, which
  validates the mechanism.

### Pattern source: Stripe smokescreen

Repository: [stripe/smokescreen](https://github.com/stripe/smokescreen).

- Go, MIT, Stripe production infrastructure. CONNECT egress proxy with
  per-client-role ACLs and — the underrated part — **post-DNS-resolution IP
  checks blocking internal/private ranges**: SSRF defense none of the Node
  options provide. It does have MITM header injection (`mitm_domains` +
  `add_headers` via Stripe's goproxy fork), but injection is static YAML per
  role+domain, not programmable per-request, and ACLs are hostname-glob only.
- Rejected as the proxy (dynamic per-session allowlists + programmable
  substitution don't fit its config model), but **adopt the post-resolution
  private-IP deny check as a pattern** (~50 lines) — it closes the
  SSRF-via-allowlisted-CNAME hole.

### Rejected

| Candidate | Why not |
|---|---|
| mitmproxy (Python, 44k stars) | Capability unmatched, but drags a full Python runtime into a Node appliance; viable only as a compose sidecar with a Python addon we'd maintain. srt's own README lists it as the BYO-proxy option; OpenSandbox builds on it — both confirm the mechanism, neither changes the runtime mismatch. |
| OpenSandbox egress sidecar (Go, Apache-2.0, Alibaba-lineage) | Architecturally the strongest bypass-resistance (shares the sandbox netns: DNS proxy + nftables default-deny, no env-var honor system) — but Linux-only, needs `CAP_NET_ADMIN`, one sidecar per sandbox, and credential injection rides on embedded mitmproxy (Python inside the sidecar). Heavier than one shared proxy; revisit if env-var bypass ever becomes a real hole in our `--network none` + proxy-only shape. |
| proxy-chain (Apify) | Maintained, but CONNECT tunneling only — no TLS interception, cannot inject into HTTPS. Fails requirement 2. |
| node-http-mitm-proxy / hoxy | Dormant (2024) / dead (2022). |
| Squid | ssl-bump + `request_header_add` technically cover both requirements, but per-session dynamic ACLs need external helpers or per-session instances, and cert management is manual — exactly the operational pain we're avoiding. |
| tinyproxy / 3proxy | No MITM or header injection. Fail requirement 2. |
| pipelock | Agent-egress *firewall* (DLP/exfil scanning, signed audit receipts), not credential brokering. Complementary idea, not a substitute. |
| buildkite/cleanroom, coder/boundary | Too small/immature (≤ ~50 stars). |

### Cross-cutting egress notes

- TLS termination requires the per-session MITM CA in the sandbox trust
  bundle: `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, pip/curl
  equivalents — plus the per-host termination opt-out for cert-pinned targets.
- The sandbox network shape becomes: `--network none` replaced by
  proxy-only egress (internal network whose only route is the proxy), so the
  proxy is a wall, not an env-var convention.

## Secrets storage candidates

### Adopted: envelope encryption in OMA's SQLite ("build thin")

- AES-256-GCM via `node:crypto` (HKDF included) — zero new dependencies.
- **Envelope shape**: each secret encrypted under its own random DEK; each DEK
  wrapped by a master KEK from `OMA_MASTER_KEY` env or a key file. KEK
  rotation re-wraps DEKs (small rows) without rewriting ciphertexts, and the
  KEK-wrap operation is precisely where an external KMS/OpenBao-transit
  backend plugs in later. Version-prefix ciphertexts (`v1:`) for migration.
- Precedents, verified:
  - **n8n** encrypts all stored credentials with an instance key from
    `N8N_ENCRYPTION_KEY` (or an auto-generated key file) — the same model,
    battle-tested at very large self-host scale.
  - **open-ma's `oma-vault`** is not a vault: source-verified as AES-256-GCM
    WebCrypto over the ordinary shared SQLite/Postgres DB, fronted by a
    mockttp MITM proxy that injects `Authorization`/`x-api-key` by hostname.
    Their entire "vault" is storage-side encryption plus the egress proxy —
    independent convergence on this survey's verdict. (One thing to do better
    than them: true envelope encryption; their single-layer key derivation
    makes rotation orphan data, which they document.)
- OAuth refresh lifecycles need no new dependency either: the **MCP
  TypeScript SDK** ships `refreshAuthorization` (the refresh mechanics for MCP
  servers), and **openid-client** (panva, MIT, actively maintained) covers
  generic OIDC/OAuth if non-MCP providers appear. OMA persists tokens
  encrypted and re-persists on refresh.

### Deferred backend: OpenBao

Repository: [openbao/openbao](https://github.com/openbao/openbao).

- Go, MPL-2.0, Linux Foundation, active (v2.5.x releases current at review
  time), ~77 MB compressed image — the only credible small-sidecar vault.
- **Why not now — the decisive argument**: OpenBao's single-node
  [static auto-unseal](https://openbao.org/docs/configuration/seal/static/)
  reads a 32-byte AES-256-GCM key from `env://` or `file://`. That is
  cryptographically the same trust model as our KEK-from-env: an attacker who
  can read our process env can read the sidecar's too. The sidecar adds a
  container, an unseal ceremony, TLS, a client library, and a second stateful
  data dir (integrated Raft or filesystem — **no SQLite backend**, splitting
  the backup story) while adding no stronger root of trust on a single
  machine.
- **When it becomes right**: SaaS/enterprise deployments where the unseal key
  genuinely lives elsewhere (cloud KMS, HSM) — i.e., when the trust-model
  upgrade is real. The `SecretsStore` KEK-wrap seam is designed so this is a
  backend swap, not a redesign. Node access via the Vault-compatible API
  (`node-vault`, MIT, maintained).

### Rejected

| Candidate | Why not |
|---|---|
| HashiCorp Vault | **BSL 1.1** (not OSI open source; forbids competing-service offerings) — a redistribution liability inside a self-hostable OSS appliance. Ruled out on license alone; also operationally heavy. |
| Infisical (as dependency) | MIT core, excellent product, wrong weight class: self-host requires **Postgres + Redis** (no minimal mode; verified in their compose docs), ~758 MB image. Three extra containers in a product that chose SQLite to stay small. Possible *optional* SaaS-tier integration someday. |
| CyberArk Conjur OSS | Ruby, LGPL-3.0, requires Postgres, slow release cadence, weak Node story, enterprise-workflow-shaped. |
| SOPS + age | Healthy projects, wrong tool shape: they encrypt files at rest for humans/git. OMA needs programmatic row-level read/write of frequently-rotating tokens — whole-file re-encrypt per token refresh, no API. Fine for deploy-time config files; not the credential store. |
| Nango | Manages OAuth refresh lifecycles well, but Elastic License 2.0 and a whole platform. |
| psst / keymaxxer / misc "agent secrets" libs | Conceptually validating ("agents use secrets without seeing them") but too young (≤ ~230 stars) to sit at this seam. No mature embeddable Node envelope-encryption library exists worth adopting. |

## Modularity stance (what seams to keep, what is YAGNI)

The Postgres/SQLite question already set the pattern: interfaces where a
second implementation is *named and plausible*, no frameworks for speculative
ones (cf. the "do not add a ResourceManager framework" lesson in
[file-storage-prior-art.md](file-storage-prior-art.md)).

Keep (cheap seams with a named future implementation):

- **`SecretsStore` interface** — small CRUD surface over encrypted secrets,
  SQLite-backed today. Second implementation named: OpenBao/KMS-backed for
  SaaS.
- **KEK-wrap function as its own seam** inside the store — the exact point
  where env-key wrapping is replaced by transit/KMS wrapping. This is one
  function, not a framework.
- **Egress policy as data, not code**: a session's egress policy (allowlist
  entries, credential grants mapping sentinel → secret ref + inject hosts)
  is a plain serializable object resolved by the control plane. The proxy
  consumes it through a narrow module boundary. This keeps the policy
  testable without a proxy and maps directly onto hosted
  `environment.config.networking`.

Refuse (YAGNI):

- **An `EgressProxyProvider` registry/abstraction with pluggable proxy
  backends.** There is one implementation (the vendored srt stack) and no
  named second one; a swap, if ever needed, replaces one module behind the
  policy contract above. Building swap machinery now is the ResourceManager
  mistake.
- **A generic vault-provider plugin system.** The KEK-wrap seam plus the
  `SecretsStore` interface already capture every realistic replacement point.

## Next steps (before any ADR)

1. **Confidence probe** (the same probe class that killed the microsandbox
   secret path, per #130's acceptance criteria): vendor srt's proxy files into
   `scratch/`, run a Docker container whose only route is the proxy, and prove
   end-to-end: (a) allowlisted host works, (b) non-allowlisted host denied,
   (c) redirect to a non-allowlisted host denied, (d) sentinel substituted at
   the boundary — the controlled echo target observes the real value (that is
   the substitution proof), while the container's env, filesystem, and its own
   outbound request construction never hold it, (e) private-IP literal /
   CNAME-to-private denied once the smokescreen-style check is added.

   Scope note on (d): boundary injection cannot hide the secret from a
   *reflective allowlisted upstream* — the request that leaves the boundary
   genuinely carries the real credential, and srt pipes upstream responses
   back unmodified (`upRes.pipe(res)`, `tls-terminate-proxy.ts`; header
   mutation is outbound-only). A cooperating echo endpoint therefore returns
   the secret into the sandbox by design. Mitigations are allowlist trust
   (only inject toward hosts that don't reflect credentials) and, optionally,
   OMA-layer response redaction — an explicit design question for the ADR
   (Osaurus's output scrubbing in
   [agentos-osaurus-prior-art.md](agentos-osaurus-prior-art.md) is the prior
   art).
2. Envelope-encryption probe: throwaway script proving DEK/KEK
   wrap–unwrap–rotate round-trip with `node:crypto` before pinning the
   `SecretsStore` schema.
3. Then the ADR: egress policy contract + `SecretsStore`, citing this survey;
   it also closes #130 ("explicit ruling that provider secret proxy stays out
   of scope and OMA-level boundary injection is the design instead").
