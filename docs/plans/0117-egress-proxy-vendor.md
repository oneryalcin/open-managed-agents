# 0117 Egress proxy vendor + credentialed egress

Date: 2026-07-03

Implements: [ADR 0016](../adrs/0016-egress-proxy-and-secret-injection.md).
Roadmap: capability track of the [0114 roadmap](0114-appliance-product-roadmap.md).
Delivers with [0118 SecretsStore](#) the "credentialed egress" capability:
an operator grants a sandboxed agent credentialed access to an allowlisted
host without the agent ever seeing the key.

## Vendoring spike (2026-07-03)

Confirmed the srt proxy stack lifts cleanly. Import graph of the six proxy
files is closed over: `http-proxy`, `tls-terminate-proxy`, `mitm-ca`,
`request-filter`, `parent-proxy`, `mitm-leaf` (~1,460 LOC), plus one internal
`utils/debug.js` (a 20-line `SRT_DEBUG` stderr logger). Only external dep is
**`node-forge@1.4.0`** (cert minting for the MITM CA). No `zod`/`commander`/
`socks5-server` — those are the CLI and SOCKS paths, which the HTTP proxy does
not use. Public entry we drive: `createHttpProxyServer(options)` from
`http-proxy` and `createMitmCA`/`disposeMitmCA` from `mitm-ca` (probe 44 drove
exactly these).

## Decisions

- **Vendor the `.ts` source** from the pinned tag (srt `0.0.63`) into
  `src/control-plane/egress/vendor/`, with a `VENDOR.md` recording the tag, the
  upstream commit, the file list, and the diff-on-release tracking commitment
  from ADR 0016 §1. Fall back to the shipped `dist/*.js` + `*.d.ts` only if the
  source is not cleanly fetchable. Keep the vendored files as verbatim as
  possible so upstream diffs stay legible; OMA-specific changes live in a thin
  wrapper module, not edits to the vendored files (exception: the two
  hardening changes below, which must be marked with `// OMA:` comments).
- **Replace `utils/debug.js`** with a one-line shim to OMA's logger rather than
  vendoring srt's — it is the only cross-cutting import and stubbing it keeps
  the dep surface to `node-forge` alone.
- **`node-forge` becomes a direct `dependency`** (not dev) — it is now runtime
  code. Pin the exact version.
- The srt package **stays a devDependency** for the probes (`scratch/44`),
  which keep driving upstream directly as a drift check against our vendored
  copy.

## Sub-slices (each its own PR)

### 0117a — Pure vendor, no behavior change

Copy the six files + a debug shim into `src/control-plane/egress/vendor/`,
add `node-forge`, and expose the public surface in `egress/proxy.ts`: the
`createEgressProxy` wrapper (mandates a non-empty per-session `proxyAuthToken`
— the vendor default is fail-open — and rejects `parentProxy`, which the vendor
ignores on the terminated leg) plus the CA/type re-exports. The raw fail-open
`createHttpProxyServer` is NOT re-exported. Typecheck clean. A port of probe
44's checks becomes a real contract test (`egress/__tests__/`) — allowlist,
sentinel→real substitution, path deny, proxy auth (missing + wrong token),
verify-before-inject (wrong upstream CA), and the mandatory-token guard — so
the vendored code is exercised in CI, not just by the scratch probe.
**Not a complete egress boundary yet**: the SSRF/private-IP deny (0117b) and
wiring (0117c/d) are still owed; `proxy.ts` says so. No control-plane wiring.

### 0117b — SSRF/private-IP deny in the dial path (ADR 0016 §5) — ✅ DONE

`egress/ssrf.ts`: `createPinnedLookup()` returns a `dns.lookup`-compatible
function that resolves once, denies if ANY resolved address is in the
private/loopback/link-local/ULA/CGNAT/reserved blocklist (IPv4 + IPv6, incl.
IPv4-mapped IPv6), and otherwise returns the vetted IP for Node to connect to
directly — no re-resolution, so no DNS-rebinding TOCTOU; the hostname stays as
TLS SNI. Threaded through the vendored dial sites via a `lookup` option
(VENDOR.md mod #5). `createEgressProxy` **defaults** the lookup to the pinned
one, so OMA egress is SSRF-safe by construction; a caller may override it
(tests reaching a loopback fixture do). Tests (`ssrf.test.ts`): the
`isBlockedAddress` battery (private/loopback/link-local/CGNAT/metadata/
IPv4-mapped denied, public allowed), the lookup denies a hostname resolving to
loopback, and an **end-to-end** default proxy allows the CONNECT but blocks the
loopback dial so the upstream is never reached (mutation-verified: removing the
default injection flips it). Probed the core mechanism first
(`scratch` throwaway) — a custom `lookup` genuinely gates the socket and Node
connects only to the returned IP.

### 0117c — Egress policy as data + resolution — ✅ DONE

`egress/policy.ts`: the serializable policy (allow entries: host + port +
optional path prefix + opaqueTunnel flag; credential grants: secret name → env
sentinel + host/port + **required pathPrefix** + optional methods + header).
`parseNetworkingConfig` strictly validates `environment.config.networking`
(unknown keys rejected — a typo must not widen policy; credentials must target
an allowlisted, non-opaque host; pathPrefix mandatory per ADR 0016 §6).
`resolveSessionEgress` returns undefined when there's no networking config (the
env stays `--network none`, no proxy) or else mints per-session sentinels
(`sandboxEnv`) and the proxy hook set. Hooks: `filter` (host+port allowlist),
`shouldTerminateTLS` (opaque opt-out), `allowOpaqueTunnel` (per-host raw-tunnel
grant), `filterRequest` (path-prefix + **sentinel-scope enforcement**: a
sentinel in the wrong header/host/path/method, or over plain HTTP, is denied),
`mutateHeaders` (grant-scoped sentinel→`reveal()`ed secret, revealed lazily per
request so rotation is picked up, **never throws** — reveal failure strips the
header).

Secret resolution is injected as a pre-bound `revealSecret(name)` closure, so
`policy.ts` has no `SecretsStore` import — the 0118 store is wired in by the
caller (0117d / service layer), and tests drive a stub.

**Path-prefix hardening** (probed first): the URL parser collapses `..` and
`%2e%2e` dot segments, but `..%2f` / `%2f..` survive in `pathname` — an upstream
that decodes them would escape the prefix. `pathWithinPrefix` matches on segment
boundaries AND denies any decoded form containing a `..` path step (fails closed
on malformed encoding too).

**Vendor mods** (all `// OMA:`, in VENDOR.md #6–8): request context on the
mutate-headers hooks; the `allowOpaqueTunnel` choke point; a fail-closed
`.catch` on the terminated forward path (a throwing hook must not become an
unhandled rejection).

**Not here** (0117d): Docker proxy-only-egress wiring, sandbox env delivery,
per-session proxy lifecycle. **Not here** (later): a secrets HTTP/management
API.

### 0117d — Wire proxy-only egress into the Docker provider — ✅ DONE (boundary + confinement test)

Replace `--network none` with a proxy-only internal network for environments
that grant egress (default stays `--network none`, ADR 0016 §2). Inject the
per-session MITM CA into the sandbox trust bundle and the `HTTPS_PROXY` +
per-session proxy-auth token. **The confinement test ADR 0016 owes**: a client
with proxy env removed / using raw sockets cannot egress directly.

**Topology — per-session dual-homed proxy sidecar** (probed 2026-07-05, all
four Docker network modes tested). An in-process host proxy is unreachable
from a confined sandbox: `--internal` drops even host-gateway traffic (good
for confinement, but the sandbox can't reach a host process), and a plain
bridge reaches the host but leaves the whole internet open (`INTERNET_OPEN`
in the probe). The only mode giving *both* reachability and confinement is a
**dual-homed proxy container**: the vendored `createEgressProxy` runs in its
own container attached to a per-session `--internal` network (sandbox side)
*and* a bridge (upstream side); the sandbox joins the internal-only network,
whose sole route out is the proxy. Probe-confirmed: sandbox reaches the
sidecar (`PORT_OPEN`) while a direct dial to `1.1.1.1:80` is dropped. Chosen
over (a) UDS+in-container relay on `--network none` (operationally heavy: a
relay binary + supervision inside every egress sandbox) and (b) control-plane
dual-homing itself (puts the session-owning, secret-holding, docker.sock
control plane on an attacker-controlled per-session network — wrong trust
boundary; also only works when OMA itself is containerized). The sidecar
keeps the control plane **off** the sandbox network.

**The proxy leaves the control-plane process.** So the JS hook closures from
`resolveSessionEgress` can't cross the boundary — the sidecar rebuilds them
from serializable data. New seam in `policy.ts`:
- `SessionEgressBundle` — a plain serializable object: `{ policy, grants
  (with per-session sentinels), secrets (secretName → real value, resolved
  ONCE at launch), proxyAuthToken, listenPort }`.
- `resolveSessionEgressBundle({ environmentConfig, revealSecret })` →
  `{ sandboxEnv, bundle }` (control-plane side): parse, mint sentinels,
  resolve the session's granted secrets once. Returns undefined for
  no-egress (→ `--network none`).
- `buildHooksFromBundle(bundle)` (sidecar side): `revealSecret = (name) =>
  bundle.secrets[name]`, then the *unchanged* `buildHooks`.
The existing closure-based `resolveSessionEgress` stays for in-process use
and its tests; both share `buildHooks`.

**Secret + CA delivery (no plaintext via env, no key leaves the sidecar).**
Per session, control-plane creates an OMA-owned host dir `oma-egress-<sid>/`.
The **sidecar generates its own MITM CA** (`createMitmCA` with no paths → it
mints an ephemeral CA), writes `ca.crt` + a `ready` marker into that dir; its
CA *private key never leaves the sidecar container*. Control-plane writes the
resolved `SessionEgressBundle` as `bundle.json` (mode 0600) into the same dir,
bind-mounted **only** into the sidecar (never the sandbox). Env is not used
for secrets — `docker inspect` exposes container env. Control-plane waits for
`ready`, then bind-mounts `ca.crt` (read-only) into the sandbox trust bundle
and sets `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS` / `GIT_SSL_CAINFO` +
`HTTPS_PROXY=http://<token>@proxy:PORT` + the proxy-auth token.
**Tradeoff (documented):** secrets are resolved at launch, so mid-session
master-key rotation is not picked up until the next session. Acceptable for
bounded sessions.

**Proxy entrypoint** `src/egress-proxy-main.ts` — reuses the appliance
`node:24-slim` image with a different `CMD` (no second image to ship): reads
`bundle.json`, generates the CA, `buildHooksFromBundle`, `createEgressProxy`,
listens. Sidecar carries reaper labels + is torn down with the session
(container + both networks).

**Lifecycle (per egress-granted session).** create `oma-egress-<sid>`
(`--internal`) → launch sidecar dual-homed (internal + bridge) → wait `ready`
→ run sandbox on the internal net only, CA + proxy env injected → teardown
removes sidecar + networks. Default (no networking config) is untouched:
`--network none`, no sidecar, no networks.

**What shipped.** `policy.ts` bundle seam (`SessionEgressBundle`,
`resolveSessionEgressBundle`, `buildHooksFromBundle`); `src/egress-proxy-main.ts`
sidecar entrypoint; `sandbox/docker-egress.ts` (`createEgressSidecar` +
per-session network/sidecar lifecycle + `reapEgressSidecars`);
`buildDockerRunArgs` egress mode (network swap + CA mount + trust/proxy/sentinel
env) threaded through `createDockerSandboxProvider` (which disposes the sidecar
on teardown). Tests: bundle-seam round-trip + fail-closed (5), run-args egress
vs default-deny (2), sidecar arg construction (3), the sidecar's trust-bundle
publish (1), the failure-cleanup path (1), the age-bounded reaper temp sweep (1),
and the **gated confinement integration test** — a real `--internal` sandbox
proves proxy-only egress at the CONNECT layer (407 no-auth, 403 off-allowlist,
200 in-allowlist) and that a raw socket to a public IP is dropped;
mutation-checked (sandbox on `bridge` breaks it). Design de-risked by two
live-Docker probes (2026-07-05): the four network-mode reachability/confinement
matrix, and the sidecar entrypoint running end-to-end in a container (MITM
termination + CA trust + enforcement).

**Review fixes (two Codex rounds, folded in, each mutation-checked).** Round 1:
(1) a sandbox-start failure now disposes the already-created sidecar — else its
container + the resolved-secret bundle leak; (2) the sidecar publishes the full
**trust bundle** (MITM CA + public roots), not just the CA: the sandbox trust
env vars *replace* the client store, so CA-only would break TLS verification for
any opaque-tunnel host the proxy does not terminate; (3) crash cleanup hardened —
`bundle.json` is unlinked the instant the sidecar signals ready (secrets at-rest
window ~1s), the `--internal` networks are labelled + age-reaped with the sidecar
containers, stale `oma-egress-*` temp roots are swept, and the egress reaper is
wired into the same startup sweep as the container reaper. Round 2 (the sidecar
IS the boundary now): (4) **least-privilege hardening** to the sandbox standard —
`--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only` root, a small
`--tmpfs /tmp` (CA minting) + `HOME=/tmp`, non-root `--user <control-plane
uid:gid>` (so it can still read the 0600 bundle it must, without root), and
memory/pids limits; probe-verified the hardened sidecar still boots + enforces
407/403/200. (5) the proxy-auth token is percent-encoded in the proxy URL and
constrained to a URL-safe charset at the seam, so a delimiter can't malform the
URL or alter the credential. (6) caller labels can no longer shadow the reserved
reaper/ownership labels (`sidecarLabels` applies reserved keys last).

**Deliberately NOT in this slice — the session integration (next).** Nothing
yet calls `resolveSessionEgressBundle`/`createEgressSidecar` from the *live*
session runner, because that is where OMA first *consumes* secrets: it needs a
per-workspace `SecretsStore` (0118) stood up in the deployment/workspace layer
and `environment.config.networking` threaded into session start. That is a
distinct slice (call it 0117e / "secrets consumption") — the egress boundary and
its confinement proof land here first, on their own, behind a gated test.
Follow-up to file: a dedicated egress-upstream bridge so sidecars are not
adjacent on the default `bridge`.

## Tests owed (from ADR 0016 validation)

- route-level confinement (0117d): proxy env removed / raw socket cannot egress
  — ✅ DONE (gated confinement test: raw dial to a public IP is dropped by the
  `--internal` net; egress works only through the auth'd, allowlisting proxy);
- private-IP deny actually denies, incl. the rebinding flip (0117b) — ✅;
- verify-before-inject holds in the wired path (carry probe 44 (g) into a
  contract test) — proven in the 0117d container probe (CA-verified MITM leaf);
  a contract test in the *wired session* path lands with 0117e;
- path/method-scoped inject grants deny an off-path request (0117c) — ✅.

## Non-goals

Skills, MCP, repo mounts (later capability slices). Response redaction (ADR
0016 §6, deferred past v1). Multi-provider egress beyond Docker-local.
