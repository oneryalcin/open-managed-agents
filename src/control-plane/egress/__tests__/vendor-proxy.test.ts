import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawTunnel, tunnelRequest } from "./tunnel-helpers.ts";
import {
  createEgressProxy,
  createMitmCA,
  disposeMitmCA,
  type MitmCA,
} from "../proxy.ts";
// Contract test for the vendored srt egress proxy (plan 0117a). Exercises the
// vendored code in CI without Docker: an in-process TLS echo upstream, the
// proxy, and a dep-free manual CONNECT+TLS tunnel client. This is the in-suite
// counterpart to scratch/44 (which uses a real container). Carries the
// load-bearing invariants — allowlist, sentinel->real substitution, path deny,
// proxy auth (missing + wrong token), and verify-before-inject (a wrong upstream
// CA fails and the injected secret never leaves) — so a bad re-pin of the
// vendor fails here.

const SENTINEL = "Bearer sent-xyz";
const REAL = "Bearer real-xyz";
const TOKEN = "session-token";

describe("vendored egress proxy contract (plan 0117a)", () => {
  let work: string;
  let echo: Server;
  let echoPort: number;
  let tcpEcho: TcpServer;
  let tcpEchoPort: number;
  let proxy: ReturnType<typeof createEgressProxy>;
  let proxyPort: number;
  let ca: MitmCA;
  const upstreamSeen: Array<string | undefined> = [];

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "egress-contract-"));
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", join(work, "k.pem"), "-out", join(work, "c.pem"),
      "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    ]);
    echo = createServer(
      { key: readFileSync(join(work, "k.pem")), cert: readFileSync(join(work, "c.pem")) },
      (req, res) => {
        upstreamSeen.push(req.headers.authorization);
        res.end(JSON.stringify({ auth: req.headers.authorization ?? null }));
      },
    );
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    echoPort = (echo.address() as { port: number }).port;

    // Allowlisted TCP echo: it would reflect raw bytes if the opaque-tunnel
    // default ever regressed to allow, so the default-deny test below has a
    // genuine differential (an HTTPS upstream would reject the bytes anyway).
    tcpEcho = createTcpServer((sock) => sock.pipe(sock));
    await new Promise<void>((r) => tcpEcho.listen(0, "127.0.0.1", () => r()));
    tcpEchoPort = (tcpEcho.address() as { port: number }).port;

    ca = createMitmCA({});
    proxy = createEgressProxy({
      filter: (port, host) =>
        host === "localhost" && (port === echoPort || port === tcpEchoPort),
      mitmCA: ca,
      filterRequest: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/blocked") {
          return { action: "deny", reason: "path blocked" };
        }
        return { action: "allow" };
      },
      mutateHeaders: (headers, destHost) => {
        if (destHost === "localhost" && headers.authorization === SENTINEL) {
          headers.authorization = REAL;
        }
      },
      tlsTerminateUpstreamCA: readFileSync(join(work, "c.pem")),
      proxyAuthToken: TOKEN,
      dangerouslyAllowPrivateAddressesForTest: true,
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    proxyPort = (proxy.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => proxy.close(() => r()));
    await new Promise<void>((r) => echo.close(() => r()));
    await new Promise<void>((r) => tcpEcho.close(() => r()));
    await disposeMitmCA(ca);
    rmSync(work, { recursive: true, force: true });
  });

  it("allows an allowlisted host and substitutes sentinel->real at the boundary", async () => {
    const res = await tunnelRequest({ proxyPort, host: "localhost", port: echoPort, ca: ca.certPem, headers: { Authorization: SENTINEL }, token: TOKEN });
    expect(res.httpStatus).toBe(200);
    // Upstream saw the REAL secret; the client only ever sent the sentinel.
    expect(res.body).toContain(REAL);
    expect(upstreamSeen.at(-1)).toBe(REAL);
  });

  it("denies a non-allowlisted host at CONNECT (403)", async () => {
    const res = await tunnelRequest({ proxyPort, host: "example.com", port: 443, ca: ca.certPem, token: TOKEN });
    expect(res.connectStatus).toBe(403);
    expect(res.httpStatus).toBe(0); // tunnel never opened
  });

  it("denies a disallowed path via filterRequest inside the tunnel (403)", async () => {
    const before = upstreamSeen.length;
    const res = await tunnelRequest({ proxyPort, host: "localhost", port: echoPort, ca: ca.certPem, headers: { Authorization: SENTINEL }, token: TOKEN });
    // NOTE: this hits "/", which is allowed; the /blocked case is next.
    expect(res.httpStatus).toBe(200);
    const blocked = await tunnelRequest({ proxyPort, host: "localhost", port: echoPort, ca: ca.certPem, token: TOKEN, path: "/blocked" });
    expect(blocked.httpStatus).toBe(403);
    expect(upstreamSeen.length).toBe(before + 1); // only the allowed "/" reached upstream
  });

  it("rejects a missing proxy-auth token (407)", async () => {
    const res = await tunnelRequest({ proxyPort, host: "localhost", port: echoPort, ca: ca.certPem });
    expect(res.connectStatus).toBe(407);
  });

  it("rejects a wrong proxy-auth token (407)", async () => {
    const res = await tunnelRequest({ proxyPort, host: "localhost", port: echoPort, ca: ca.certPem, token: "not-the-token" });
    expect(res.connectStatus).toBe(407);
  });

  it("verify-before-inject: a wrong upstream CA fails and the injected secret never leaves", async () => {
    // Second proxy: client-facing termination uses the trusted CA (so the
    // client tunnels in fine), but the UPSTREAM leg is told to trust a
    // freshly-minted bogus CA that never signed the echo cert. The upstream TLS
    // verify must fail before any mutated bytes leave, so the echo never sees
    // the request and the REAL secret is never transmitted.
    const bogusCa = createMitmCA({});
    const wrongProxy = createEgressProxy({
      filter: (port, host) => host === "localhost" && port === echoPort,
      mitmCA: ca,
      filterRequest: async () => ({ action: "allow" }),
      mutateHeaders: (headers, destHost) => {
        if (destHost === "localhost" && headers.authorization === SENTINEL) {
          headers.authorization = REAL;
        }
      },
      tlsTerminateUpstreamCA: bogusCa.certPem,
      proxyAuthToken: TOKEN,
      dangerouslyAllowPrivateAddressesForTest: true,
    });
    await new Promise<void>((r) => wrongProxy.listen(0, "127.0.0.1", r));
    const wrongPort = (wrongProxy.address() as { port: number }).port;
    try {
      const before = upstreamSeen.length;
      const res = await tunnelRequest({ proxyPort: wrongPort, host: "localhost", port: echoPort, ca: ca.certPem, headers: { Authorization: SENTINEL }, token: TOKEN });
      expect(upstreamSeen.length).toBe(before); // echo never received it
      expect(res.httpStatus).not.toBe(200); // proxy returns 502 inside the tunnel
      expect(res.body).not.toContain(REAL); // secret never appeared to the client either
    } finally {
      await new Promise<void>((r) => wrongProxy.close(() => r()));
      await disposeMitmCA(bogusCa);
    }
  });

  it("createEgressProxy throws without a proxy-auth token (no fail-open default)", () => {
    expect(() =>
      createEgressProxy({
        filter: () => true,
        proxyAuthToken: "",
      }),
    ).toThrow(/non-empty proxyAuthToken/);
  });

  // The SSRF boundary must be safe by construction: the public surface cannot
  // hand back a proxy whose upstream resolution escapes the pinned lookup.
  it("createEgressProxy rejects a caller lookup (would replace the SSRF resolver)", () => {
    expect(() =>
      createEgressProxy({
        filter: () => true,
        proxyAuthToken: "tok",
        // deliberately bypass the type omission
        lookup: (() => {}) as never,
      } as never),
    ).toThrow(/does not accept a caller lookup/);
  });

  it("createEgressProxy rejects getMitmSocketPath (external MITM route bypasses the lookup)", () => {
    expect(() =>
      createEgressProxy({
        filter: () => true,
        proxyAuthToken: "tok",
        getMitmSocketPath: (() => "/tmp/x.sock") as never,
      } as never),
    ).toThrow(/does not support getMitmSocketPath/);
  });

  it("defaults opaque tunnels to deny: non-TLS bytes on CONNECT are killed (ADR 0016 §3)", () => {
    // No allowOpaqueTunnel hook was passed to createEgressProxy, so the
    // wrapper's default-deny applies. The target is an allowlisted TCP echo —
    // an echo of the payload here means the uninspected-tunnel fallback is
    // back.
    return rawTunnel({
      proxyPort,
      host: "localhost",
      port: tcpEchoPort,
      token: TOKEN,
      payload: "raw-bytes-should-die",
    }).then((res) => {
      expect(res.connectStatus).toBe(200); // the sniff needs the 200 first
      expect(res.closed).toBe(true);
      expect(res.response).toBe("");
    });
  });

  it("createEgressProxy rejects parentProxy", () => {
    expect(() =>
      createEgressProxy({
        filter: () => true,
        proxyAuthToken: "tok",
        parentProxy: {} as never,
      } as never),
    ).toThrow(/does not support parentProxy/);
  });
});
