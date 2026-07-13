# Plan 0127 — CMA Networking Parity

Date: 2026-07-12  
Branch: `arc-c-networking`  
Evidence: [probe 60](../../scratch/60-managed-agents-networking-probe.md),
[probe 61](../../scratch/61-managed-agents-networking-edge-probe.md),
[probe 62](../../scratch/62-managed-agents-networking-depth-probe.md),
[PARITY.md](../../PARITY.md)

## Requirements summary

Remove the current silent contradiction where a CMA-shaped
`environment.config.networking` is accepted and stored but the sandbox remains
at OMA's default `--network none`. Support the safely translatable subset of
CMA `limited` networking, reject the unsupported/unsafe subset explicitly, and
preserve OMA's existing native `networking.allow` / `credentials` policy.

The environment response must continue to echo the caller's original CMA
configuration. Translation is an internal session-egress concern, not a
rewrite of persisted public data. Invalid hosted shapes must fail as a 400
before the environment row is written; malformed legacy rows must fail closed
at session admission rather than silently disabling egress.

## RALPLAN-DR summary

### Principles

1. Never accept a networking request whose effective access differs silently
   from what the caller requested.
2. Preserve default-deny, SSRF filtering, TLS termination, and boundary secret
   injection; translation must not widen those controls.
3. Keep hosted-shape parsing separate from OMA-native policy parsing so the two
   contracts cannot drift accidentally.
4. Reject unsupported capability flags explicitly until their complete runtime
   semantics are implemented.

### Decision drivers

1. Security: wildcard and special-capability translation must fail closed.
2. Hosted evidence: probes 61 and 62 establish behavior for the tested empty
   list, one-level and nested wildcard, HTTP/HTTPS, package-manager, MCP, and
   invalid-host cases. Probe 62 is not a universal proof of CMA transport
   semantics; HTTPS-only is the deliberately conservative OMA mapping for this
   slice unless a later control probe changes that decision.
3. Scope: deliver a bounded pre-v1 trust fix without inventing a package
   registry catalog or changing the control-plane-side MCP architecture.

### Viable options

**Option A — Translate the safe limited subset; reject the rest (recommended).**

- Translate `type: "limited"` + `allowed_hosts` into internal allow entries for
  HTTPS (443) only, with case normalization and exact / `*.`
  subdomain matching.
- Accept `allow_package_managers: false` and `allow_mcp_servers: false`.
- Reject `type: "unrestricted"`, `allow_package_managers: true`, and
  `allow_mcp_servers: true` with a clear 400 until their complete semantics are
  designed. Empty `allowed_hosts` remains valid default-deny.
- Pros: no silent behavior, bounded code, preserves OMA's security model.
- Cons: explicit divergence for unrestricted and the two true capability flags;
  those divergences must remain visible in `PARITY.md`.

**Option B — Translate every hosted flag immediately.**

- Add a fixed registry catalog for all package managers and derive sandbox
  allowlist entries from each agent's configured MCP URLs.
- Pros: broader hosted compatibility in one slice.
- Cons: registry catalog completeness, package-manager redirects, MCP URL
  ownership, and control-plane-vs-sandbox dialing semantics are not settled by
  the current probes. This would risk a new form of silent widening, so it is
  rejected for this slice.

## Contract decisions

### Hosted `limited`

- Required shape: object with `type: "limited"`, `allowed_hosts` array, and the
  two optional boolean flags. If either flag is present, it must be a boolean.
- `allowed_hosts: []` is accepted and produces no egress bundle (default deny).
  Internally this empty policy resolves to `undefined`, so session admission
  does not require an egress capability for a policy that makes no egress
  request.
- Bare hostnames are normalized to lowercase for internal matching; the public
  environment row remains unchanged. Probe 61 shows CMA accepts uppercase
  entries and preserves them.
- A leading `*.` means a subdomain pattern. Probe 62 shows it matches one or
  more labels before the suffix and never matches the bare suffix itself. The
  matcher must be shared by connection filtering and request filtering.
- Each translated hosted host grants HTTPS on port 443 only. Probe 62 denied
  HTTP for the tested exact and wildcard hosts; the plan treats that as the
  conservative OMA mapping, not a claim that one probe establishes every CMA
  transport rule. CMA's public contract forbids ports in `allowed_hosts`; URL
  and port-bearing entries are rejected before a session can be created.
- Transport is part of the translated policy: hosted entries carry an
  internal `protocol: "https"` marker. `filterRequest` and the plain-request /
  CONNECT paths must deny an `http:` request even when it targets port 443.
  Native OMA entries omit this marker and retain their existing protocol-
  agnostic behavior.
- Reject empty/invalid hostnames, schemes, ports, trailing-dot forms, and
  unsupported wildcard forms with `invalid_request_error`.
- Hosted and native shapes are disjoint: a hosted object must have `type` and
  `allowed_hosts` and may contain only the two boolean capability flags; a
  native object must use only `allow` and `credentials`. Mixed or ambiguous
  objects are rejected rather than guessed. Hostnames are ASCII DNS names or
  wildcard suffixes; reject IP literals, underscores, empty labels, trailing
  dots, non-leading wildcards, and duplicate entries after lowercase
  normalization. Punycode is accepted as ordinary ASCII; Unicode hostnames are
  rejected instead of applying an implicit IDN conversion.
- Concrete hostname grammar: each hostname has at least two labels, total
  length at most 253 bytes, and labels of length 1–63 containing only
  ASCII letters, digits, and internal hyphens (no leading/trailing hyphen).
  A wildcard is exactly `*.` followed by a valid two-or-more-label suffix;
  forms such as `*.com`, `foo.*.example.com`, and a bare `*` are rejected.

### Unsupported hosted shapes

- `type: "unrestricted"` → 400. OMA has no bounded equivalent to “all
  internet,” and silently leaving the sandbox isolated is worse than an honest
  incompatibility.
- `allow_package_managers: true` → 400 with an explicit unsupported-capability
  message. Do not guess a registry list; package installation is not yet an
  OMA environment capability.
- `allow_mcp_servers: true` → 400 with an explicit unsupported-capability
  message for this slice. OMA MCP dials from the control plane, not the
  sandbox, so treating this flag as a generic host bypass would be wrong.
- Both flags set to `false` are accepted and have no additional effect.

### Validation timing and persistence

- Validate hosted networking at environment creation so newly persisted rows
  cannot contain unsupported shapes.
- Revalidate at session admission for legacy rows or rows written by another
  storage path. The session must fail before sandbox preparation or external
  egress side effects.
- The environment service maps hosted/native parser errors to the repository's
  `invalidRequest` error (HTTP 400) and writes no row on failure. The session
  service and egress-bundle resolver use the same classifier: only absent
  networking and a valid hosted empty allowlist resolve to no bundle; unknown,
  mixed, malformed, or unsupported legacy shapes throw an invalid request.
- Keep OMA-native `networking.allow` / `credentials` behavior unchanged.
- Normalize only the internal policy; never mutate the public environment
  response or stored JSON.

## Implementation steps

1. **Add a hosted-network parser/normalizer** in
   `src/control-plane/egress/policy.ts`.
   - Define a small internal hosted-policy type.
   - Detect hosted-vs-native networking without weakening native strict
     parsing; reject unknown, mixed, or missing-discriminator shapes.
   - Validate flags and the concrete hostname grammar, normalize case, reject
     duplicate normalized entries, expand HTTPS/443, and expose a single
     wildcard-aware host matcher.
   - Carry the hosted-only `protocol: "https"` marker into translated allow
     entries. Enforce it in `filterRequest` and the plain HTTP/CONNECT path so
     `http://allowed-host:443` cannot bypass the HTTPS-only decision. Leave
     native entries unmarked and behavior-compatible.
   - Keep native `parseNetworkingConfig` strict and unchanged for credentials.

2. **Route both environment creation and session admission through it.**
   - `src/control-plane/environments/service.ts`: validate the hosted shape
     before inserting the row; map parser failures to `invalidRequest`/400,
     preserve the original JSON on success, and prove no row is created on
     failure.
   - `src/control-plane/sessions/service.ts`: replace the current
     `hasEgressNetworkingConfig`-only gate with the shared classifier; reject
     unsupported, mixed, or malformed legacy rows before
     `prepareFileResources` or `prepareSkillResources`.
   - `src/control-plane/wiring.ts`: resolve the normalized hosted policy when
     constructing a per-session egress bundle; return `undefined` only for no
     networking or a valid hosted empty allowlist, never for an unrecognized
     networking object.

3. **Make proxy enforcement pattern-safe.**
   - Update `buildHooks` in `egress/policy.ts` so `filter`, `filterRequest`,
     `shouldTerminateTLS`, and `allowOpaqueTunnel` all use the same exact/
     wildcard matcher, and make the hosted protocol marker effective on both
     TLS and plain-request legs.
   - Ensure credential grants remain exact-host/path scoped and cannot inherit
     a hosted wildcard accidentally.

4. **Add focused contract coverage.**
   - `src/control-plane/egress/__tests__/policy.test.ts`: exact and wildcard
     matching, base-domain denial, nested-subdomain behavior, uppercase
     normalization, 443-only expansion with HTTP/443 denial, empty allowlist,
     invalid host forms, mixed-shape rejection, duplicate normalization,
     concrete grammar boundaries, and unsupported flags. Include a native
     unmarked 443 policy proving its existing protocol behavior is unchanged.
   - Environment API tests: accepted limited response preserves input;
     unrestricted/true flags/invalid hosts/mixed shapes return 400 and create
     no row; parser errors are never exposed as 500s.
   - Session/wiring tests: hosted limited produces a bundle, hosted empty stays
     dark without an egress capability, native empty keeps its existing
     semantics, and legacy unsupported/malformed rows fail before runtime
     preparation. Exercise both the environmentId creation hint and normal
     persisted-session resolution.
   - Extend the gated Docker egress test with a hosted limited config proving
     allowed and disallowed hosts use the same sidecar enforcement path.

5. **Update public truth.**
   - Replace the README quickstart's `type: "unrestricted"` example with either
     no networking config or an explicit OMA-native allowlist.
   - Update `PARITY.md` to mark the accept-and-ignore trap resolved while
     recording the deliberate unrestricted/package-manager/MCP rejections and
     their follow-up scope.
   - Keep `handoff.md` pointing to `PARITY.md` as the backlog source.

6. **Verify the slice.**
   - Run typecheck, focused policy/environment/session tests, the gated Docker
     egress tests, full Vitest, and `git diff --check`.
   - Re-read the normalized policy and proxy matcher together after coding.
   - Run the existing hosted probe artifacts as evidence regression; probe 62
     resolves wildcard depth and HTTP/HTTPS semantics.

## Acceptance criteria

- A CMA `limited` environment with `allowed_hosts: ["api.example.com"]` is
  accepted, returns its original config, and grants only that host on port 443;
  `https://api.example.com` is allowed while `http://api.example.com:443` is
  denied at both plain-request and CONNECT/request-filter paths.
- `*.example.com` allows `www.example.com` and nested subdomains, denies
  `example.com` and an unrelated host, and denies HTTP for all of them at both
  connection and request-filter layers.
- `allowed_hosts: []` is accepted but produces no sidecar/proxy egress.
- `unrestricted`, URL-bearing hosts, port-bearing hosts, and true unsupported
  capability flags return 400 `invalid_request_error` and do not produce a
  network-capable session.
- Uppercase hostnames are accepted and normalized only for internal matching.
- Invalid hosted parser input maps to 400 and leaves no environment row; legacy
  invalid/mixed rows fail closed at session admission and bundle resolution.
- Native OMA `allow` / `credentials` configs and secret-injection tests remain
  unchanged, including their existing protocol behavior when entries are not
  marked as hosted translations.
- No secret enters environment JSON, sandbox env, events, logs, or probe
  artifacts.
- Typecheck, focused tests, Docker egress tests, and full suite pass.

## Risks and mitigations

- **Wildcard overmatch** — centralize suffix matching, deny the bare suffix,
  and test connection/request paths separately.
- **HTTP/HTTPS mismatch** — a port-only allow check can admit
  `http://host:443`; carry a hosted-only protocol marker and enforce it in
  both request legs. Do not widen hosted inputs to HTTP without new evidence
  and an explicit policy decision.
- **Flag widening** — reject true package/MCP flags rather than inventing a
  partial registry or MCP policy.
- **Legacy rows** — use a shared discriminated classifier and fail closed at
  both session admission and bundle resolution, before any sandbox side effect.
- **Public contract drift** — preserve stored JSON and update README/PARITY in
  the same slice.

## ADR

### Decision

Translate only the evidence-backed CMA `limited` host allowlist into OMA's
internal proxy policy, and reject unrestricted/unsupported capability flags
explicitly.

### Drivers

Security, probe-backed semantics, and a bounded pre-v1 scope.

### Alternatives considered

Full translation was rejected because package-manager registries and
control-plane MCP dialing are not equivalent to sandbox host egress. Rejecting
all CMA networking was rejected because limited host allowlists have a safe,
testable mapping.

### Why chosen

It removes the current silent contradiction while preserving OMA's stronger
default-deny and secret-boundary guarantees.

### Consequences

Limited host allowlists become useful through OMA's sidecar. Some valid CMA
configs receive an honest 400 until later capability slices implement their
semantics. Native OMA networking remains backward compatible.

### Review fold (2026-07-13)

An independent native security/architecture review found the plan coherent but
identified four implementation-critical clarifications, now folded above:

- hosted parser failures must become `invalidRequest`/400 before persistence;
- probe 62's HTTPS result is scoped evidence, while HTTPS-only remains the
  conservative OMA decision rather than an overclaimed universal CMA rule;
- malformed or mixed legacy networking rows must fail closed instead of being
  treated as absent networking;
- hosted 443 grants require an explicit HTTPS transport marker enforced on both
  plain-request and CONNECT/request-filter paths, without changing native OMA
  behavior.

### Follow-ups

- Revisit HTTP access only with new hosted evidence and an explicit policy
  decision; probe 62 currently shows HTTPS-only behavior.
- Design package-manager registry policy and control-plane MCP/networking
  interaction as separate parity slices.
- Revisit `unrestricted` only with an explicit operator safety gate and a
  bounded “allow all” design.
