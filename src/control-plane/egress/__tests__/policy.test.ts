import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildHooksFromBundle,
  EgressPolicyError,
  hostMatchesAllowPattern,
  parseNetworkingConfig,
  pathWithinPrefix,
  resolveSessionEgress,
  resolveSessionEgressBundle,
} from "../policy.ts";
import { createEgressProxy, createMitmCA, disposeMitmCA, type MitmCA } from "../proxy.ts";
import { absoluteFormProxyRequest, rawTunnel, tunnelRequest } from "./tunnel-helpers.ts";

// Policy tests for plan 0117c (ADR 0016 §2/§3/§6). Three layers:
//  - strict parsing: a typo'd or over-broad config must be rejected, never
//    silently widened;
//  - path matching: the encoding differentials the probe surfaced;
//  - e2e: the full credentialed-egress contract on a live proxy — sentinels
//    substituted only inside their grant scope, opaque tunnels only for
//    flagged hosts, secrets stripped (not leaked, not crashed) on failure.

describe("parseNetworkingConfig", () => {
  const base = {
    networking: {
      allow: [{ host: "api.github.com", pathPrefix: "/repos" }],
      credentials: [
        {
          secret: "github",
          env: "GITHUB_TOKEN",
          host: "api.github.com",
          pathPrefix: "/repos",
          methods: ["get", "POST"],
        },
      ],
    },
  };

  it("parses a full config with defaults applied", () => {
    const policy = parseNetworkingConfig(structuredClone(base))!;
    expect(policy.allow).toEqual([
      { host: "api.github.com", port: 443, pathPrefix: "/repos", opaqueTunnel: false },
    ]);
    expect(policy.credentials).toEqual([
      {
        secret: "github",
        env: "GITHUB_TOKEN",
        host: "api.github.com",
        port: 443,
        pathPrefix: "/repos",
        methods: ["GET", "POST"], // normalized uppercase
        header: "authorization", // default
      },
    ]);
  });

  it("returns undefined when there is no networking key (default deny, no proxy)", () => {
    expect(parseNetworkingConfig({})).toBeUndefined();
  });

  // A typo'd key must fail loudly — an ignored "pathPrefx" would silently
  // widen the policy to the whole host.
  it.each([
    ["top level", { networking: { allow: [], extra: 1 } }],
    ["allow entry", { networking: { allow: [{ host: "a.com", pathPrefx: "/x" }] } }],
    [
      "credential",
      {
        networking: {
          allow: [{ host: "a.com" }],
          credentials: [
            { secret: "s", env: "T", host: "a.com", pathPrefix: "/", metods: ["GET"] },
          ],
        },
      },
    ],
  ])("rejects an unknown key at the %s", (_at, config) => {
    expect(() => parseNetworkingConfig(config as never)).toThrow(EgressPolicyError);
    expect(() => parseNetworkingConfig(config as never)).toThrow(/unknown key/);
  });

  it("rejects a credential whose host:port is not allowlisted", () => {
    const config = structuredClone(base);
    config.networking.credentials[0]!.host = "evil.example";
    expect(() => parseNetworkingConfig(config)).toThrow(/not in networking.allow/);
  });

  it("rejects a credential on an opaqueTunnel host (no termination, no injection)", () => {
    const config = {
      networking: {
        allow: [{ host: "a.com", opaqueTunnel: true }],
        credentials: [{ secret: "s", env: "T", host: "a.com", pathPrefix: "/" }],
      },
    };
    expect(() => parseNetworkingConfig(config)).toThrow(/opaqueTunnel host/);
  });

  it("rejects a credential without a pathPrefix (ADR 0016 §6)", () => {
    const config = structuredClone(base);
    delete (config.networking.credentials[0] as { pathPrefix?: string }).pathPrefix;
    expect(() => parseNetworkingConfig(config)).toThrow(/pathPrefix/);
  });

  it.each([
    ["uppercase host", { host: "API.github.com" }],
    ["wildcard host", { host: "*.github.com" }],
    ["trailing-dot host", { host: "api.github.com." }],
    ["empty host", { host: "" }],
    ["bad port", { host: "a.com", port: 0 }],
    ["float port", { host: "a.com", port: 443.5 }],
    ["pathPrefix without slash", { host: "a.com", pathPrefix: "repos" }],
    ["pathPrefix on opaque host", { host: "a.com", opaqueTunnel: true, pathPrefix: "/x" }],
  ])("rejects an allow entry with %s", (_what, entry) => {
    expect(() =>
      parseNetworkingConfig({ networking: { allow: [entry] } }),
    ).toThrow(EgressPolicyError);
  });

  it("rejects duplicate allow entries and duplicate credential envs", () => {
    expect(() =>
      parseNetworkingConfig({
        networking: { allow: [{ host: "a.com" }, { host: "a.com" }] },
      }),
    ).toThrow(/duplicate entry/);
    const dupEnv = structuredClone(base);
    dupEnv.networking.credentials.push({ ...dupEnv.networking.credentials[0]! });
    expect(() => parseNetworkingConfig(dupEnv)).toThrow(/duplicate env/);
  });

  it("rejects a lowercase/invalid env var name", () => {
    const config = structuredClone(base);
    config.networking.credentials[0]!.env = "github_token";
    expect(() => parseNetworkingConfig(config)).toThrow(/UPPER_SNAKE_CASE/);
  });
});

describe("hosted CMA networking", () => {
  const limited = (allowed_hosts: string[], extra: Record<string, unknown> = {}) => ({
    networking: { type: "limited", allowed_hosts, ...extra },
  });

  it("translates limited hostnames to HTTPS/443 entries without mutating input", () => {
    const config = limited(["API.Example.com", "*.Example.org"], {
      allow_package_managers: false,
      allow_mcp_servers: false,
    });
    const policy = parseNetworkingConfig(config)!;
    expect(policy).toEqual({
      allow: [
        { host: "api.example.com", port: 443, protocol: "https", opaqueTunnel: false },
        { host: "*.example.org", port: 443, protocol: "https", opaqueTunnel: false },
      ],
      credentials: [],
    });
    expect(config.networking.allowed_hosts).toEqual(["API.Example.com", "*.Example.org"]);
  });

  it("matches exact hosts and one-or-more wildcard labels, never the bare suffix", () => {
    expect(hostMatchesAllowPattern("api.example.com", "API.EXAMPLE.COM")).toBe(true);
    expect(hostMatchesAllowPattern("api.example.com", "other.example.com")).toBe(false);
    expect(hostMatchesAllowPattern("*.example.com", "example.com")).toBe(false);
    expect(hostMatchesAllowPattern("*.example.com", "www.example.com")).toBe(true);
    expect(hostMatchesAllowPattern("*.example.com", "a.b.example.com")).toBe(true);
    expect(hostMatchesAllowPattern("*.example.com", ".example.com")).toBe(false);
    expect(hostMatchesAllowPattern("*.example.com", "foo..example.com")).toBe(false);
    expect(hostMatchesAllowPattern("*.example.com", "evil.example.net")).toBe(false);
  });

  it("keeps hosted empty lists default-deny while preserving native empty semantics", () => {
    expect(parseNetworkingConfig(limited([]))).toBeUndefined();
    expect(parseNetworkingConfig({ networking: { allow: [] } })).toEqual({
      allow: [],
      credentials: [],
    });
  });

  it.each([
    ["unrestricted", { networking: { type: "unrestricted" } }],
    ["unknown type", { networking: { type: "limited-ish", allowed_hosts: [] } }],
    ["missing allowed_hosts", { networking: { type: "limited" } }],
    ["mixed hosted/native", { networking: { type: "limited", allowed_hosts: [], allow: [] } }],
    ["unknown shape", { networking: { typo: true } }],
    ["package managers", limited([], { allow_package_managers: true })],
    ["MCP servers", limited([], { allow_mcp_servers: true })],
    ["nonboolean package flag", limited([], { allow_package_managers: "false" })],
    ["nonboolean MCP flag", limited([], { allow_mcp_servers: 0 })],
  ])("rejects %s", (_what, config) => {
    expect(() => parseNetworkingConfig(config as never)).toThrow(EgressPolicyError);
  });

  it.each([
    ["URL", "https://example.com"],
    ["port", "example.com:443"],
    ["IP literal", "127.0.0.1"],
    ["IPv6 literal", "::1"],
    ["IDN", "éxample.com"],
    ["underscore", "foo_bar.example.com"],
    ["trailing dot", "example.com."],
    ["one label", "localhost"],
    ["leading hyphen", "-foo.example.com"],
    ["trailing hyphen", "foo-.example.com"],
    ["long label", `${"a".repeat(64)}.com`],
    ["long hostname", `${"a.".repeat(126)}com`],
    ["bare wildcard suffix", "*.com"],
    ["nested wildcard syntax", "foo.*.example.com"],
    ["bare wildcard", "*"],
  ])("rejects hosted %s", (_what, host) => {
    expect(() => parseNetworkingConfig(limited([host]))).toThrow(EgressPolicyError);
  });

  it("rejects duplicate hosts after lowercase normalization", () => {
    expect(() => parseNetworkingConfig(limited(["Example.com", "example.com"]))).toThrow(
      /duplicate entry/,
    );
  });

  it("enforces the hosted HTTPS marker at request and opaque-tunnel layers", async () => {
    const hooks = resolveSessionEgress({
      environmentConfig: limited(["api.example.com", "*.wild.example.com"]),
      revealSecret: () => undefined,
    })!.hooks;

    await expect(
      hooks.filterRequest!(
        new Request("https://api.example.com/path"),
        { leg: "terminated" },
      ),
    ).resolves.toEqual({ action: "allow" });
    await expect(
      hooks.filterRequest!(
        new Request("http://api.example.com:443/path"),
        { leg: "plain" },
      ),
    ).resolves.toMatchObject({ action: "deny", reason: /HTTPS transport/ });
    await expect(
      hooks.filterRequest!(
        new Request("https://api.example.com/path"),
        { leg: "plain" },
      ),
    ).resolves.toEqual({ action: "allow" });
    expect(hooks.shouldTerminateTLS!("api.example.com", 443)).toBe(true);
    expect(hooks.allowOpaqueTunnel!("api.example.com", 443)).toBe(false);
    expect(hooks.shouldTerminateTLS!("www.wild.example.com", 443)).toBe(true);
    expect(hooks.filter!(443, "a.b.wild.example.com", undefined as never)).toBe(true);
    expect(hooks.filter!(443, "wild.example.com", undefined as never)).toBe(false);
  });

  it("leaves native entries protocol-agnostic", async () => {
    const hooks = resolveSessionEgress({
      environmentConfig: { networking: { allow: [{ host: "api.example.com", port: 443 }] } },
      revealSecret: () => undefined,
    })!.hooks;
    await expect(
      hooks.filterRequest!(
        new Request("http://api.example.com:443/path"),
        { leg: "plain" },
      ),
    ).resolves.toEqual({ action: "allow" });
  });
});

describe("pathWithinPrefix", () => {
  it.each([
    // [pathname (as URL-parser output), prefix, expected]
    ["/repos", "/repos", true],
    ["/repos/x", "/repos", true],
    ["/repositories-evil", "/repos", false], // segment boundary
    ["/admin", "/repos", false], // parser already collapsed /repos/../admin
    ["/repos/..%2fadmin", "/repos", false], // encoded slash: upstream may decode
    ["/repos%2f../admin", "/repos", false],
    ["/repos/%zz", "/repos", false], // malformed encoding: fail closed
    ["//repos/x", "/repos", false],
    ["/repos/a%20b", "/repos", true], // benign encoding within the prefix
  ])("(%s, %s) -> %s", (pathname, prefix, expected) => {
    expect(pathWithinPrefix(pathname, prefix)).toBe(expected);
  });
});

// The mutateHeaders hook is the last line before a secret leaves the boundary.
// filterRequest normally denies an off-scope sentinel first, so the e2e never
// exercises mutateHeaders' own scope guard — test it in isolation, so a
// refactor that lets the two hooks disagree can't silently ship an injection.
describe("mutateHeaders scope guard (defense in depth)", () => {
  function hooksFor() {
    return resolveSessionEgress({
      environmentConfig: {
        networking: {
          allow: [{ host: "api.x", pathPrefix: "/api/repos" }],
          credentials: [
            {
              secret: "s",
              env: "TOKEN",
              host: "api.x",
              pathPrefix: "/api/repos",
              methods: ["GET"],
            },
          ],
        },
      },
      revealSecret: () => "REAL",
    })!;
  }

  it("injects the real secret when the request context is in scope", () => {
    const egress = hooksFor();
    const sentinel = egress.sandboxEnv["TOKEN"]!;
    const headers: Record<string, string | string[] | undefined> = {
      authorization: `Bearer ${sentinel}`,
    };
    egress.hooks.mutateHeaders!(headers, "api.x", {
      method: "GET",
      path: "/api/repos/oma",
      port: 443,
    });
    expect(headers.authorization).toBe("Bearer REAL");
  });

  it.each([
    ["off-path", { method: "GET", path: "/api/other", port: 443 }],
    ["off-method", { method: "POST", path: "/api/repos/oma", port: 443 }],
    ["off-port", { method: "GET", path: "/api/repos/oma", port: 8443 }],
  ])("strips the sentinel when the context is %s (never injects, never leaks)", (_case, context) => {
    const egress = hooksFor();
    const sentinel = egress.sandboxEnv["TOKEN"]!;
    const headers: Record<string, string | string[] | undefined> = {
      authorization: `Bearer ${sentinel}`,
    };
    egress.hooks.mutateHeaders!(headers, "api.x", context);
    expect(headers.authorization).toBeUndefined();
  });
});

describe("resolveSessionEgressBundle + buildHooksFromBundle (sidecar seam, 0117d)", () => {
  const config = {
    networking: {
      allow: [{ host: "api.x", pathPrefix: "/api/repos" }],
      credentials: [
        {
          secret: "gh",
          env: "TOKEN",
          host: "api.x",
          pathPrefix: "/api/repos",
          methods: ["GET"],
        },
      ],
    },
  };

  it("returns undefined when the environment grants no egress (default deny holds)", () => {
    expect(
      resolveSessionEgressBundle({
        environmentConfig: {},
        revealSecret: () => undefined,
        listenPort: 8080,
        proxyAuthToken: "tok",
      }),
    ).toBeUndefined();
  });

  it("rejects an empty proxy auth token (the vendored proxy is fail-open without one)", () => {
    expect(() =>
      resolveSessionEgressBundle({
        environmentConfig: config,
        revealSecret: () => "REAL",
        listenPort: 8080,
        proxyAuthToken: "  ",
      }),
    ).toThrow(EgressPolicyError);
  });

  it("mints sentinels into both the sandbox env and the bundle grants, resolving secrets once", () => {
    let reveals = 0;
    const resolved = resolveSessionEgressBundle({
      environmentConfig: config,
      revealSecret: (name) => {
        reveals += 1;
        return name === "gh" ? "REAL" : undefined;
      },
      listenPort: 8080,
      proxyAuthToken: "tok",
    })!;
    const sentinel = resolved.sandboxEnv["TOKEN"]!;
    expect(sentinel).toMatch(/^oma-sentinel-[0-9a-f]{32}$/);
    // The sidecar's grant must carry the SAME sentinel the sandbox holds.
    expect(resolved.bundle.grants[0]!.sentinel).toBe(sentinel);
    expect(resolved.bundle.secrets).toEqual({ gh: "REAL" });
    expect(resolved.bundle.proxyAuthToken).toBe("tok");
    expect(resolved.bundle.listenPort).toBe(8080);
    expect(reveals).toBe(1); // resolved once at launch, not per request
  });

  it("round-trips: hooks rebuilt from the serialized bundle inject the real secret in scope", () => {
    const resolved = resolveSessionEgressBundle({
      environmentConfig: config,
      revealSecret: () => "REAL",
      listenPort: 8080,
      proxyAuthToken: "tok",
    })!;
    // Serialize and rebuild exactly as the sidecar does.
    const bundle = JSON.parse(JSON.stringify(resolved.bundle));
    const hooks = buildHooksFromBundle(bundle);
    const headers: Record<string, string | string[] | undefined> = {
      authorization: `Bearer ${resolved.sandboxEnv["TOKEN"]}`,
    };
    hooks.mutateHeaders!(headers, "api.x", {
      method: "GET",
      path: "/api/repos/oma",
      port: 443,
    });
    expect(headers.authorization).toBe("Bearer REAL");
  });

  it("a grant whose secret cannot be revealed is absent from the bundle and stripped (fail closed survives serialization)", () => {
    const resolved = resolveSessionEgressBundle({
      environmentConfig: config,
      revealSecret: () => undefined, // deleted secret / retired key
      listenPort: 8080,
      proxyAuthToken: "tok",
    })!;
    expect(resolved.bundle.secrets).toEqual({});
    const hooks = buildHooksFromBundle(
      JSON.parse(JSON.stringify(resolved.bundle)),
    );
    const headers: Record<string, string | string[] | undefined> = {
      authorization: `Bearer ${resolved.sandboxEnv["TOKEN"]}`,
    };
    hooks.mutateHeaders!(headers, "api.x", {
      method: "GET",
      path: "/api/repos/oma",
      port: 443,
    });
    expect(headers.authorization).toBeUndefined(); // never the sentinel, never a secret
  });
});

// ---------------------------------------------------------------------------
// E2E: the resolved hooks on a live proxy.

const REAL_GH = "real-gh-token-9f3a";

describe("credentialed egress e2e (plan 0117c)", () => {
  let work: string;
  let echo: HttpsServer;
  let echoPort: number;
  let plainEcho: HttpServer;
  let plainEchoPort: number;
  let opaqueEcho: TcpServer;
  let opaquePort: number;
  let unflaggedTcpEcho: TcpServer;
  let unflaggedTcpPort: number;
  let proxy: ReturnType<typeof createEgressProxy>;
  let proxyPort: number;
  let hostedProxy: ReturnType<typeof createEgressProxy>;
  let hostedProxyPort: number;
  let ca: MitmCA;
  const HOSTED_TOKEN = "hosted-session-token";
  let sentinel: string;
  let stripSentinel: string;
  const upstreamSeen: Array<{ path: string; auth?: string; apiKey?: string }> = [];
  const TOKEN = "session-token";

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "egress-policy-"));
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", join(work, "k.pem"), "-out", join(work, "c.pem"),
      "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    ]);
    echo = createHttpsServer(
      { key: readFileSync(join(work, "k.pem")), cert: readFileSync(join(work, "c.pem")) },
      (req, res) => {
        upstreamSeen.push({
          path: req.url ?? "",
          auth: req.headers.authorization as string | undefined,
          apiKey: req.headers["x-api-key"] as string | undefined,
        });
        res.end(JSON.stringify({ auth: req.headers.authorization ?? null }));
      },
    );
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    echoPort = (echo.address() as { port: number }).port;

    plainEcho = createHttpServer((req, res) => {
      upstreamSeen.push({ path: `plain:${req.url ?? ""}` });
      res.end("plain-ok");
    });
    await new Promise<void>((r) => plainEcho.listen(0, "127.0.0.1", r));
    plainEchoPort = (plainEcho.address() as { port: number }).port;

    opaqueEcho = createTcpServer((sock) => sock.pipe(sock));
    await new Promise<void>((r) => opaqueEcho.listen(0, "127.0.0.1", () => r()));
    opaquePort = (opaqueEcho.address() as { port: number }).port;

    // A second TCP echo that is allowlisted but NOT opaque-flagged: if the
    // opaque gate ever regresses, non-TLS bytes would tunnel through and
    // echo back — a real differential, unlike an HTTPS upstream that would
    // reject the bytes anyway.
    unflaggedTcpEcho = createTcpServer((sock) => sock.pipe(sock));
    await new Promise<void>((r) => unflaggedTcpEcho.listen(0, "127.0.0.1", () => r()));
    unflaggedTcpPort = (unflaggedTcpEcho.address() as { port: number }).port;

    const egress = resolveSessionEgress({
      environmentConfig: {
        networking: {
          allow: [
            { host: "localhost", port: echoPort, pathPrefix: "/api" },
            { host: "localhost", port: opaquePort, opaqueTunnel: true },
            { host: "localhost", port: plainEchoPort },
            { host: "localhost", port: unflaggedTcpPort },
          ],
          credentials: [
            {
              secret: "github",
              env: "GITHUB_TOKEN",
              host: "localhost",
              port: echoPort,
              pathPrefix: "/api/repos",
              methods: ["GET"],
            },
            {
              secret: "gone-secret",
              env: "GONE_TOKEN",
              host: "localhost",
              port: echoPort,
              pathPrefix: "/api/strip",
              header: "x-api-key",
            },
          ],
        },
      },
      // The workspace-scoped resolver: "github" resolves, "gone-secret"
      // doesn't (models a deleted secret / retired-key store).
      revealSecret: (name) => (name === "github" ? REAL_GH : undefined),
    })!;
    expect(egress).toBeDefined();
    sentinel = egress.sandboxEnv["GITHUB_TOKEN"]!;
    stripSentinel = egress.sandboxEnv["GONE_TOKEN"]!;

    ca = createMitmCA({});
    proxy = createEgressProxy({
      ...egress.hooks,
      mitmCA: ca,
      tlsTerminateUpstreamCA: readFileSync(join(work, "c.pem")),
      proxyAuthToken: TOKEN,
      dangerouslyAllowPrivateAddressesForTest: true,
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    proxyPort = (proxy.address() as { port: number }).port;

    // Exercise the hosted translation through the real proxy stack. The
    // fixture cannot bind to privileged port 443, so only the internal test
    // hostname is rewritten to localhost; the translated HTTPS/443 marker is
    // deliberately left unchanged. Both denial paths happen before dialing.
    const hosted = resolveSessionEgress({
      environmentConfig: {
        networking: { type: "limited", allowed_hosts: ["api.example.com"] },
      },
      revealSecret: () => undefined,
    })!;
    hosted.policy.allow[0]!.host = "localhost";
    hostedProxy = createEgressProxy({
      ...hosted.hooks,
      mitmCA: ca,
      tlsTerminateUpstreamCA: readFileSync(join(work, "c.pem")),
      proxyAuthToken: HOSTED_TOKEN,
      dangerouslyAllowPrivateAddressesForTest: true,
    });
    await new Promise<void>((r) => hostedProxy.listen(0, "127.0.0.1", r));
    hostedProxyPort = (hostedProxy.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => hostedProxy.close(() => r()));
    await new Promise<void>((r) => proxy.close(() => r()));
    await new Promise<void>((r) => echo.close(() => r()));
    await new Promise<void>((r) => plainEcho.close(() => r()));
    await new Promise<void>((r) => opaqueEcho.close(() => r()));
    await new Promise<void>((r) => unflaggedTcpEcho.close(() => r()));
    await disposeMitmCA(ca);
    rmSync(work, { recursive: true, force: true });
  });

  const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
    tunnelRequest({
      proxyPort,
      host: "localhost",
      port: echoPort,
      ca: ca.certPem,
      headers,
      token: TOKEN,
      method,
      path,
    });

  it("substitutes sentinel -> real secret inside the grant scope", async () => {
    const res = await get("/api/repos/oma", { Authorization: `Bearer ${sentinel}` });
    expect(res.httpStatus).toBe(200);
    expect(upstreamSeen.at(-1)).toMatchObject({
      path: "/api/repos/oma",
      auth: `Bearer ${REAL_GH}`,
    });
    // The secret round-trips back only because this echo reflects it; the
    // sandbox client itself never held it.
    expect(res.body).toContain(REAL_GH);
  });

  it("denies the sentinel off-path (403), upstream never sees the request", async () => {
    const before = upstreamSeen.length;
    const res = await get("/api/other", { Authorization: `Bearer ${sentinel}` });
    expect(res.httpStatus).toBe(403);
    expect(res.body).toMatch(/not granted/);
    expect(upstreamSeen.length).toBe(before);
  });

  it("denies the sentinel with an ungranted method (403)", async () => {
    const before = upstreamSeen.length;
    const res = await get("/api/repos/oma", { Authorization: `Bearer ${sentinel}` }, "POST");
    expect(res.httpStatus).toBe(403);
    expect(upstreamSeen.length).toBe(before);
  });

  it("denies the sentinel smuggled in a different header (403)", async () => {
    const before = upstreamSeen.length;
    const res = await get("/api/repos/oma", { "X-Custom": `Bearer ${sentinel}` });
    expect(res.httpStatus).toBe(403);
    expect(res.body).toMatch(/outside its authorization header/);
    expect(upstreamSeen.length).toBe(before);
  });

  it("denies a path escape via encoded dot segments (403)", async () => {
    const res = await get("/api/repos/..%2f..%2fadmin", {
      Authorization: `Bearer ${sentinel}`,
    });
    expect(res.httpStatus).toBe(403);
  });

  it("denies paths outside the allow pathPrefix even without a sentinel (403)", async () => {
    const res = await get("/outside");
    expect(res.httpStatus).toBe(403);
    expect(res.body).toMatch(/outside the allowed prefix/);
  });

  it("allows in-prefix requests without a grant and injects nothing", async () => {
    const res = await get("/api/plain");
    expect(res.httpStatus).toBe(200);
    expect(upstreamSeen.at(-1)).toMatchObject({ path: "/api/plain", auth: undefined });
  });

  it("strips the credential header when the secret cannot be revealed (fail closed, no crash)", async () => {
    const res = await get("/api/strip/x", { "X-Api-Key": stripSentinel });
    expect(res.httpStatus).toBe(200); // request proceeds, upstream will 401 in real life
    const seen = upstreamSeen.at(-1)!;
    expect(seen.path).toBe("/api/strip/x");
    expect(seen.apiKey).toBeUndefined(); // neither sentinel nor secret transited
  });

  it("kills non-TLS bytes on a CONNECT to a non-flagged host (no opaque fallback)", async () => {
    // The target is a TCP echo that WOULD reflect the bytes if the opaque
    // gate regressed — so an echo here is a genuine policy breach, not an
    // upstream that happened to reject the payload.
    const res = await rawTunnel({
      proxyPort,
      host: "localhost",
      port: unflaggedTcpPort,
      token: TOKEN,
      payload: "SSH-2.0-OpenSSH_9.7\r\n",
    });
    expect(res.connectStatus).toBe(200); // sniff needs the 200 first
    expect(res.closed).toBe(true);
    expect(res.response).toBe(""); // nothing echoed: the tunnel died
  });

  it("opaque-tunnels raw bytes for an explicitly flagged host", async () => {
    const res = await rawTunnel({
      proxyPort,
      host: "localhost",
      port: opaquePort,
      token: TOKEN,
      payload: "raw-bytes-hello",
    });
    expect(res.connectStatus).toBe(200);
    expect(res.response).toBe("raw-bytes-hello"); // echoed end-to-end
  });

  it("denies a sentinel over plain HTTP (injection is TLS-only)", async () => {
    const res = await absoluteFormProxyRequest({
      proxyPort,
      targetUrl: `http://localhost:${plainEchoPort}/whatever`,
      token: TOKEN,
      headers: {
        authorization: `Bearer ${sentinel}`,
      },
    });
    expect(res.httpStatus).toBe(403);
  });

  it("blocks hosted http://allowed-host:443 through the real proxy", async () => {
    const res = await absoluteFormProxyRequest({
      proxyPort: hostedProxyPort,
      targetUrl: "http://localhost:443/should-not-dial",
      token: HOSTED_TOKEN,
    });
    expect(res.httpStatus).toBe(403);
    expect(res.body).toMatch(/requires HTTPS transport/);
  });

  it("kills plaintext bytes after a hosted CONNECT instead of opaque-tunneling", async () => {
    const res = await rawTunnel({
      proxyPort: hostedProxyPort,
      host: "localhost",
      port: 443,
      token: HOSTED_TOKEN,
      payload: "GET /should-not-tunnel HTTP/1.1\r\nHost: localhost\r\n\r\n",
    });
    expect(res.connectStatus).toBe(200);
    expect(res.closed).toBe(true);
    expect(res.response).toBe("");
  });

  it("denies an in-scope sentinel on the plain absolute-form HTTPS leg", async () => {
    const before = upstreamSeen.length;
    const res = await absoluteFormProxyRequest({
      proxyPort,
      targetUrl: `https://localhost:${echoPort}/api/repos/oma`,
      token: TOKEN,
      headers: {
        authorization: `Bearer ${sentinel}`,
      },
    });
    expect(res.httpStatus).toBe(403);
    expect(res.body).toMatch(/plain proxy leg/);
    expect(upstreamSeen.length).toBe(before);
    expect(upstreamSeen.slice(before).some((seen) => seen.auth?.includes(sentinel))).toBe(false);
  });
});
