// Egress policy as data + resolution (plan 0117c; ADR 0016 §2, §3, §6).
//
// A session's egress policy is a plain serializable object parsed from the
// environment's `config.networking`, resolved into (a) per-session sentinels
// for the sandbox environment and (b) the hook set `createEgressProxy`
// consumes. Policy is testable without a running proxy.
//
// Postures locked in here:
//   - default deny: no `networking` config -> no policy -> no proxy at all
//     (the environment stays at --network none, ADR 0016 §2);
//   - strict parse: unknown keys are rejected — a typo must not silently
//     widen policy;
//   - inject grants are path-scoped (pathPrefix REQUIRED) and optionally
//     method-scoped (ADR 0016 §6 — reflectivity is per-endpoint);
//   - secrets never enter the sandbox: the sandbox gets a random per-session
//     sentinel; the proxy substitutes the real secret at the boundary, lazily
//     revealed per request (rotation is picked up, no long-lived plaintext);
//   - injection hooks NEVER throw: a reveal failure strips the credential
//     header (fail closed for the secret) instead of crashing the proxy;
//   - opaque tunnels (no inspection, no injection) are per-host opt-ins.
import { randomBytes } from "node:crypto";
import type { JsonObject } from "../../types/json.ts";
import type { EgressProxyOptions } from "./proxy.ts";

export class EgressPolicyError extends Error {}

export interface EgressAllowEntry {
  /** Exact hostname, lowercase. No wildcards in v1. */
  host: string;
  /** Destination port; defaults to 443. */
  port: number;
  /** Optional path restriction (segment-boundary prefix match). */
  pathPrefix?: string;
  /**
   * Explicit per-host opaque-tunnel grant (mTLS / cert-pinned upstreams).
   * No TLS termination, so no path policy and no injection for this host.
   */
  opaqueTunnel: boolean;
}

export interface EgressCredentialGrant {
  /** SecretsStore secret name (workspace-scoped by the caller). */
  secret: string;
  /** Sandbox env var that will carry the per-session sentinel. */
  env: string;
  host: string;
  port: number;
  /** REQUIRED (ADR 0016 §6): injection is path-scoped, never host-wide. */
  pathPrefix: string;
  /** Uppercase HTTP methods; undefined = all methods. */
  methods?: string[];
  /** Header (lowercase) whose value carries the sentinel. */
  header: string;
}

export interface EgressPolicy {
  allow: EgressAllowEntry[];
  credentials: EgressCredentialGrant[];
}

// The subset of proxy options the policy layer produces. Spread into
// createEgressProxy alongside mitmCA / proxyAuthToken / server wiring.
export type EgressPolicyHooks = Pick<
  EgressProxyOptions,
  | "filter"
  | "filterRequest"
  | "mutateHeaders"
  | "shouldTerminateTLS"
  | "allowOpaqueTunnel"
>;

export interface SessionEgress {
  policy: EgressPolicy;
  /** Sandbox env: env var name -> per-session sentinel. */
  sandboxEnv: Record<string, string>;
  hooks: EgressPolicyHooks;
}

// ---------------------------------------------------------------------------
// Parsing (strict)

const ALLOW_KEYS = new Set(["host", "port", "pathPrefix", "opaqueTunnel"]);
const CREDENTIAL_KEYS = new Set([
  "secret",
  "env",
  "host",
  "port",
  "pathPrefix",
  "methods",
  "header",
]);
const NETWORKING_KEYS = new Set(["allow", "credentials"]);

/**
 * Parse `config.networking` into an EgressPolicy. Returns undefined when the
 * config has no `networking` key (default deny — no proxy is stood up).
 * Throws EgressPolicyError on any invalid shape.
 */
export function parseNetworkingConfig(
  config: JsonObject,
): EgressPolicy | undefined {
  const networking = config["networking"];
  if (networking === undefined) return undefined;
  if (!isPlainObject(networking)) {
    throw new EgressPolicyError("networking must be an object");
  }
  rejectUnknownKeys(networking, NETWORKING_KEYS, "networking");

  const rawAllow = networking["allow"];
  if (!Array.isArray(rawAllow)) {
    throw new EgressPolicyError("networking.allow must be an array");
  }
  const allow = rawAllow.map((entry, i) => parseAllowEntry(entry, i));
  const seen = new Set<string>();
  for (const entry of allow) {
    const key = `${entry.host}:${entry.port}`;
    if (seen.has(key)) {
      throw new EgressPolicyError(`networking.allow: duplicate entry ${key}`);
    }
    seen.add(key);
  }

  const rawCredentials = networking["credentials"] ?? [];
  if (!Array.isArray(rawCredentials)) {
    throw new EgressPolicyError("networking.credentials must be an array");
  }
  const credentials = rawCredentials.map((entry, i) =>
    parseCredentialGrant(entry, i),
  );
  const envSeen = new Set<string>();
  for (const grant of credentials) {
    // Every inject host must be an allowlisted, TERMINATED host: injection
    // happens on the decrypted leg, so an opaque host can't carry a grant.
    const target = allow.find(
      (entry) => entry.host === grant.host && entry.port === grant.port,
    );
    if (!target) {
      throw new EgressPolicyError(
        `networking.credentials: ${grant.host}:${grant.port} is not in networking.allow`,
      );
    }
    if (target.opaqueTunnel) {
      throw new EgressPolicyError(
        `networking.credentials: ${grant.host}:${grant.port} is an opaqueTunnel host — ` +
          "injection requires TLS termination",
      );
    }
    if (envSeen.has(grant.env)) {
      throw new EgressPolicyError(
        `networking.credentials: duplicate env ${grant.env}`,
      );
    }
    envSeen.add(grant.env);
  }

  return { allow, credentials };
}

function parseAllowEntry(value: unknown, index: number): EgressAllowEntry {
  const at = `networking.allow[${index}]`;
  if (!isPlainObject(value)) {
    throw new EgressPolicyError(`${at} must be an object`);
  }
  rejectUnknownKeys(value, ALLOW_KEYS, at);
  const host = parseHost(value["host"], at);
  const port = parsePort(value["port"], at);
  const opaqueTunnel = value["opaqueTunnel"] ?? false;
  if (typeof opaqueTunnel !== "boolean") {
    throw new EgressPolicyError(`${at}.opaqueTunnel must be a boolean`);
  }
  const entry: EgressAllowEntry = { host, port, opaqueTunnel };
  if (value["pathPrefix"] !== undefined) {
    if (opaqueTunnel) {
      throw new EgressPolicyError(
        `${at}: pathPrefix cannot apply to an opaqueTunnel host (no inspection)`,
      );
    }
    entry.pathPrefix = parsePathPrefix(value["pathPrefix"], at);
  }
  return entry;
}

function parseCredentialGrant(
  value: unknown,
  index: number,
): EgressCredentialGrant {
  const at = `networking.credentials[${index}]`;
  if (!isPlainObject(value)) {
    throw new EgressPolicyError(`${at} must be an object`);
  }
  rejectUnknownKeys(value, CREDENTIAL_KEYS, at);
  const secret = value["secret"];
  if (typeof secret !== "string" || secret === "") {
    throw new EgressPolicyError(`${at}.secret must be a non-empty string`);
  }
  const env = value["env"];
  if (typeof env !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(env)) {
    throw new EgressPolicyError(
      `${at}.env must be an UPPER_SNAKE_CASE env var name`,
    );
  }
  const grant: EgressCredentialGrant = {
    secret,
    env,
    host: parseHost(value["host"], at),
    port: parsePort(value["port"], at),
    // ADR 0016 §6: pathPrefix is mandatory for inject grants.
    pathPrefix: parsePathPrefix(value["pathPrefix"], at),
    header: parseHeader(value["header"], at),
  };
  if (value["methods"] !== undefined) {
    const methods = value["methods"];
    if (
      !Array.isArray(methods) ||
      methods.length === 0 ||
      !methods.every((m) => typeof m === "string" && /^[A-Za-z]+$/.test(m))
    ) {
      throw new EgressPolicyError(
        `${at}.methods must be a non-empty array of HTTP method names`,
      );
    }
    grant.methods = methods.map((m) => m.toUpperCase());
  }
  return grant;
}

function parseHost(value: unknown, at: string): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.toLowerCase() ||
    value.includes("*") ||
    value.endsWith(".")
  ) {
    throw new EgressPolicyError(
      `${at}.host must be a lowercase hostname (no wildcards, no trailing dot)`,
    );
  }
  return value;
}

function parsePort(value: unknown, at: string): number {
  if (value === undefined) return 443;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65535) {
    throw new EgressPolicyError(`${at}.port must be an integer in 1..65535`);
  }
  return value as number;
}

function parsePathPrefix(value: unknown, at: string): string {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new EgressPolicyError(
      `${at}.pathPrefix must be a string starting with "/"`,
    );
  }
  return value;
}

function parseHeader(value: unknown, at: string): string {
  if (value === undefined) return "authorization";
  if (typeof value !== "string" || !/^[a-z0-9-]+$/.test(value)) {
    throw new EgressPolicyError(
      `${at}.header must be a lowercase header name`,
    );
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  known: Set<string>,
  at: string,
): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw new EgressPolicyError(`${at}: unknown key "${key}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Path matching

/**
 * Segment-boundary prefix match with encoding hardening (probed):
 *   - the URL parser normalizes `..` and `%2e%2e` dot segments, but
 *     `..%2f` / `%2f..` survive in pathname — an upstream that decodes %2f
 *     would escape the prefix, so any decoded form containing a ".." path
 *     step is denied outright;
 *   - `/repos` matches `/repos` and `/repos/x`, never `/repositories`.
 */
export function pathWithinPrefix(pathname: string, prefix: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false; // malformed percent-encoding: fail closed
  }
  if (/(^|[/\\])\.\.([/\\]|$)/.test(decoded)) return false;
  if (pathname === prefix) return true;
  const boundary = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return pathname.startsWith(boundary);
}

// ---------------------------------------------------------------------------
// Resolution

export interface SentinelGrant extends EgressCredentialGrant {
  sentinel: string;
}

/**
 * The serializable hand-off to a proxy running OUT of the control-plane
 * process (0117d: the per-session sidecar). Plain JSON — no closures — so it
 * can be written to the sidecar's mount and rebuilt there via
 * `buildHooksFromBundle`. `secrets` is resolved ONCE at launch (secretName ->
 * real value); mid-session rotation is therefore not picked up until the next
 * session. It holds real secret material and MUST be delivered only to the
 * sidecar (mode 0600, never env, never the sandbox).
 */
export interface SessionEgressBundle {
  policy: EgressPolicy;
  grants: SentinelGrant[];
  secrets: Record<string, string>;
  proxyAuthToken: string;
  listenPort: number;
}

export interface ResolveSessionEgressOptions {
  environmentConfig: JsonObject;
  /**
   * Pre-bound (workspace-scoped) secret resolver — SecretsStore.reveal.
   * Called lazily per matching request, never at resolve time.
   */
  revealSecret: (name: string) => string | undefined;
}

/**
 * Resolve an environment's networking config into per-session egress: the
 * sandbox env (sentinels) and the proxy hook set. Returns undefined when the
 * environment grants no egress (no proxy is stood up; --network none).
 */
export function resolveSessionEgress(
  opts: ResolveSessionEgressOptions,
): SessionEgress | undefined {
  const policy = parseNetworkingConfig(opts.environmentConfig);
  if (policy === undefined) return undefined;
  const { grants, sandboxEnv } = mintSentinelGrants(policy);
  return {
    policy,
    sandboxEnv,
    hooks: buildHooks(policy, grants, opts.revealSecret),
  };
}

function mintSentinelGrants(policy: EgressPolicy): {
  grants: SentinelGrant[];
  sandboxEnv: Record<string, string>;
} {
  const grants: SentinelGrant[] = policy.credentials.map((grant) => ({
    ...grant,
    sentinel: `oma-sentinel-${randomBytes(16).toString("hex")}`,
  }));
  const sandboxEnv: Record<string, string> = {};
  for (const grant of grants) {
    sandboxEnv[grant.env] = grant.sentinel;
  }
  return { grants, sandboxEnv };
}

export interface ResolveSessionEgressBundleOptions {
  environmentConfig: JsonObject;
  /** Workspace-scoped SecretsStore.reveal. Called ONCE per granted secret. */
  revealSecret: (name: string) => string | undefined;
  /** The port the sidecar proxy will listen on inside its container. */
  listenPort: number;
  /** Non-empty per-session bearer token the sandbox presents to the proxy. */
  proxyAuthToken: string;
}

/**
 * Control-plane side of the sidecar seam (0117d). Parses the env's networking
 * config, mints per-session sentinels, and resolves the session's granted
 * secrets ONCE into a serializable {@link SessionEgressBundle}. Returns
 * undefined when the environment grants no egress (no sidecar; --network none).
 *
 * A grant whose secret cannot be revealed is simply absent from `secrets` —
 * the sidecar's injection hook strips that credential header (fail closed),
 * exactly as the in-process path does.
 */
export function resolveSessionEgressBundle(
  opts: ResolveSessionEgressBundleOptions,
): { sandboxEnv: Record<string, string>; bundle: SessionEgressBundle } | undefined {
  // The token rides in a proxy-URL userinfo slot; constrain it to a URL-safe
  // charset so a delimiter can't malform the URL or alter the credential the
  // sandbox client sends. OMA mints the token, so this is a contract, not a
  // parser — callers should pass hex / base64url.
  if (
    typeof opts.proxyAuthToken !== "string" ||
    !/^[A-Za-z0-9._~-]+$/.test(opts.proxyAuthToken)
  ) {
    throw new EgressPolicyError(
      "resolveSessionEgressBundle requires a non-empty URL-safe proxyAuthToken " +
        "([A-Za-z0-9._~-]); use hex or base64url",
    );
  }
  const policy = parseNetworkingConfig(opts.environmentConfig);
  if (policy === undefined) return undefined;
  const { grants, sandboxEnv } = mintSentinelGrants(policy);

  const secrets: Record<string, string> = {};
  for (const grant of grants) {
    if (grant.secret in secrets) continue; // resolve each secret once
    let real: string | undefined;
    try {
      real = opts.revealSecret(grant.secret);
    } catch {
      real = undefined;
    }
    if (real !== undefined) secrets[grant.secret] = real;
  }

  return {
    sandboxEnv,
    bundle: {
      policy,
      grants,
      secrets,
      proxyAuthToken: opts.proxyAuthToken,
      listenPort: opts.listenPort,
    },
  };
}

/**
 * Sidecar side of the seam: rebuild the proxy hook set from a serialized
 * {@link SessionEgressBundle}. `revealSecret` becomes a lookup into the
 * launch-time resolved map, and the SAME {@link buildHooks} runs — so the
 * sidecar and the in-process path share one enforcement implementation.
 */
export function buildHooksFromBundle(
  bundle: SessionEgressBundle,
): EgressPolicyHooks {
  return buildHooks(
    bundle.policy,
    bundle.grants,
    (name) => bundle.secrets[name],
  );
}

function buildHooks(
  policy: EgressPolicy,
  grants: SentinelGrant[],
  revealSecret: (name: string) => string | undefined,
): EgressPolicyHooks {
  const findAllow = (host: string, port: number): EgressAllowEntry | undefined =>
    policy.allow.find(
      (entry) => entry.host === host.toLowerCase() && entry.port === port,
    );

  const grantInScope = (
    grant: SentinelGrant,
    host: string,
    port: number,
    pathname: string,
    method: string,
  ): boolean =>
    grant.host === host.toLowerCase() &&
    grant.port === port &&
    pathWithinPrefix(pathname, grant.pathPrefix) &&
    (grant.methods === undefined || grant.methods.includes(method.toUpperCase()));

  return {
    filter: (port, host) => findAllow(host, port) !== undefined,

    shouldTerminateTLS: (host, port) =>
      findAllow(host, port)?.opaqueTunnel !== true,

    // ADR 0016 §3: an uninspected byte tunnel is an explicit per-host grant.
    allowOpaqueTunnel: (host, port) =>
      findAllow(host, port)?.opaqueTunnel === true,

    filterRequest: async (request, context) => {
      const url = new URL(request.url);
      const host = url.hostname.toLowerCase();
      const port = url.port
        ? Number.parseInt(url.port, 10)
        : url.protocol === "https:"
          ? 443
          : 80;
      const entry = findAllow(host, port);
      if (!entry) {
        // The connection filter already gates hosts; this fires only if the
        // two ever disagree. Fail closed.
        return { action: "deny", reason: `${host}:${port} is not allowlisted` };
      }
      if (entry.pathPrefix && !pathWithinPrefix(url.pathname, entry.pathPrefix)) {
        return {
          action: "deny",
          reason: `path ${url.pathname} is outside the allowed prefix for ${host}`,
        };
      }
      // Sentinel scope enforcement (ADR 0016 §6): a request carrying a
      // sentinel ANYWHERE outside its grant's (host, port, path, method,
      // header) scope is denied — the agent cannot steer a granted
      // credential to an ungranted endpoint. The vendor leg discriminator is
      // also load-bearing: only the TLS-terminated leg runs mutateHeaders, so
      // a sentinel on the plain request leg must fail closed before forwarding.
      for (const grant of grants) {
        for (const [headerName, headerValue] of request.headers) {
          if (!headerValue.includes(grant.sentinel)) continue;
          if (context.leg === "plain") {
            return {
              action: "deny",
              reason: `credential ${grant.env} cannot transit the plain proxy leg`,
            };
          }
          if (headerName.toLowerCase() !== grant.header) {
            return {
              action: "deny",
              reason: `credential ${grant.env} used outside its ${grant.header} header`,
            };
          }
          if (
            url.protocol !== "https:" ||
            !grantInScope(grant, host, port, url.pathname, request.method)
          ) {
            return {
              action: "deny",
              reason:
                `credential ${grant.env} is not granted for ` +
                `${request.method} ${host}:${port}${url.pathname}`,
            };
          }
        }
      }
      return { action: "allow" };
    },

    // Injection at the boundary (ADR 0016 §3). Runs only on the terminated
    // TLS leg (we never set mutateHeadersPlaintext, so a secret cannot be
    // injected into cleartext HTTP). MUST NOT throw: forwardUpstream treats
    // a hook throw as a hard failure, and the secret's fail-closed shape is
    // "strip the credential header", not "kill the proxy".
    mutateHeaders: (headers, destHost, context) => {
      if (!context) return; // no request context -> no injection
      const pathname = pathnameOf(context.path);
      for (const grant of grants) {
        const value = headers[grant.header];
        if (value === undefined) continue;
        const values = Array.isArray(value) ? value : [value];
        if (!values.some((v) => v.includes(grant.sentinel))) continue;
        if (
          pathname === undefined ||
          !grantInScope(grant, destHost, context.port, pathname, context.method)
        ) {
          // filterRequest already denies off-scope sentinels; if a request
          // reaches here anyway, never let the sentinel transit either.
          delete headers[grant.header];
          continue;
        }
        let real: string | undefined;
        try {
          real = revealSecret(grant.secret);
        } catch {
          real = undefined;
        }
        if (real === undefined) {
          // Reveal failed (missing secret, rotated key): strip rather than
          // forward the sentinel — the upstream 401 tells the agent, and
          // neither the sentinel nor a secret leaves the boundary.
          delete headers[grant.header];
          continue;
        }
        const replaced = values.map((v) => v.replaceAll(grant.sentinel, real));
        headers[grant.header] = Array.isArray(value) ? replaced : replaced[0];
      }
    },
  };
}

// context.path is the raw origin-form request-target; normalize through the
// URL parser exactly like filterRequest does, so both layers see the same
// pathname. Returns undefined (no injection) if the path cannot parse.
function pathnameOf(rawPath: string): string | undefined {
  try {
    return new URL(`https://x${rawPath.startsWith("/") ? "" : "/"}${rawPath}`)
      .pathname;
  } catch {
    return undefined;
  }
}
