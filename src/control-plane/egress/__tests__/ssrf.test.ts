import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEgressProxy, createMitmCA, disposeMitmCA, type MitmCA } from "../proxy.ts";
import { createPinnedLookup, isBlockedAddress } from "../ssrf.ts";

// SSRF / private-IP deny (plan 0117b, ADR 0016 §5).

describe("isBlockedAddress", () => {
  it("blocks private/loopback/link-local/reserved ranges", () => {
    const blocked: Array<[string, number]> = [
      ["127.0.0.1", 4],
      ["10.1.2.3", 4],
      ["172.16.0.1", 4],
      ["192.168.1.1", 4],
      ["169.254.169.254", 4], // cloud metadata
      ["100.64.0.1", 4], // CGNAT
      ["0.0.0.0", 4],
      ["::1", 6], // ipv6 loopback
      ["fc00::1", 6], // ULA
      ["fe80::1", 6], // link-local
      ["::ffff:127.0.0.1", 6], // ipv4-mapped loopback
      ["::ffff:10.0.0.1", 6], // ipv4-mapped private
      ["64:ff9b::7f00:1", 6], // NAT64-embedded 127.0.0.1
      ["64:ff9b::a00:1", 6], // NAT64-embedded 10.0.0.1
      ["2002:0a00:0001::", 6], // 6to4-embedded 10.0.0.1
      ["2001::1", 6], // Teredo
    ];
    for (const [addr, fam] of blocked) {
      expect(isBlockedAddress(addr, fam), `${addr} should be blocked`).toBe(true);
    }
  });

  it("allows public addresses", () => {
    const allowed: Array<[string, number]> = [
      ["8.8.8.8", 4],
      ["1.1.1.1", 4],
      ["140.82.121.3", 4], // github
      ["2606:4700:4700::1111", 6], // cloudflare v6
    ];
    for (const [addr, fam] of allowed) {
      expect(isBlockedAddress(addr, fam), `${addr} should be allowed`).toBe(false);
    }
  });
});

describe("createPinnedLookup", () => {
  it("denies a hostname that resolves into a blocked range (localhost)", async () => {
    const lookup = createPinnedLookup();
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      lookup("localhost", { all: true }, (e) => resolve(e));
    });
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe("EGRESS_SSRF_BLOCKED");
  });

  it("permits a blocked address when the caller explicitly allows it (test escape hatch)", async () => {
    const lookup = createPinnedLookup({ allowAddress: () => true });
    const result = await new Promise<{ err: unknown; addr: unknown }>((resolve) => {
      lookup("localhost", { all: false }, (err, addr) => resolve({ err, addr }));
    });
    expect(result.err).toBeNull();
    expect(typeof result.addr).toBe("string");
  });
});

describe("createEgressProxy default SSRF deny (end-to-end)", () => {
  let work: string;
  let echo: Server;
  let echoPort: number;
  let proxy: ReturnType<typeof createEgressProxy>;
  let proxyPort: number;
  let ca: MitmCA;
  const upstreamSeen: string[] = [];

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "ssrf-e2e-"));
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", join(work, "k.pem"), "-out", join(work, "c.pem"),
      "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    ]);
    echo = createServer(
      { key: readFileSync(join(work, "k.pem")), cert: readFileSync(join(work, "c.pem")) },
      (req, res) => {
        upstreamSeen.push(req.url ?? "");
        res.end("REACHED");
      },
    );
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    echoPort = (echo.address() as { port: number }).port;
    ca = createMitmCA({});
    // NOTE: no `lookup` override — this uses the DEFAULT pinned lookup, which
    // must refuse to dial the loopback echo even though the hostname is allowed.
    proxy = createEgressProxy({
      filter: (port, host) => host === "localhost" && port === echoPort,
      mitmCA: ca,
      filterRequest: async () => ({ action: "allow" }),
      tlsTerminateUpstreamCA: readFileSync(join(work, "c.pem")),
      proxyAuthToken: "tok",
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    proxyPort = (proxy.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => proxy.close(() => r()));
    await new Promise<void>((r) => echo.close(() => r()));
    await disposeMitmCA(ca);
    rmSync(work, { recursive: true, force: true });
  });

  it("allows the hostname at CONNECT but the default lookup blocks the loopback dial (502, upstream never reached)", async () => {
    // CONNECT is allowed by the hostname filter (tunnel opens), then the
    // terminated upstream leg resolves localhost -> loopback and the pinned
    // lookup denies it, so the proxy returns 502 and the echo never sees a hit.
    const status = await tunnelGetStatus(proxyPort, "localhost", echoPort, ca.certPem, "tok");
    expect(status).toBe(502); // specific upstream-dial failure, not just any non-200
    expect(upstreamSeen.length).toBe(0);
  });
});

describe("createEgressProxy denies blocked IP literals at CONNECT (H1)", () => {
  // Node skips the dns.lookup hook for IP literals, so the literal half of the
  // deny lives in the wrapped filter. A permissive caller filter (allow all)
  // must still not let a private/metadata literal through.
  let proxy: ReturnType<typeof createEgressProxy>;
  let proxyPort: number;

  beforeAll(async () => {
    proxy = createEgressProxy({
      filter: () => true, // deliberately permissive: the guard must still deny literals
      proxyAuthToken: "tok",
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    proxyPort = (proxy.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => proxy.close(() => r()));
  });

  for (const literal of ["127.0.0.1", "169.254.169.254", "10.0.0.1", "::1", "::ffff:10.0.0.1"]) {
    it(`denies CONNECT to blocked literal ${literal} (403) despite an allow-all filter`, async () => {
      const status = await tunnelConnectStatus(proxyPort, literal, 80, "tok");
      expect(status).toBe(403);
    });
  }
  // A public literal is NOT denied by the guard: that path is covered by the
  // isBlockedAddress unit battery (8.8.8.8 etc. → false) without a flaky real
  // network dial. The guard is exactly `if (blocked) deny else callerFilter`.
});

// CONNECT-only helper: returns the CONNECT response status (never opens TLS).
function tunnelConnectStatus(
  proxyPort: number,
  host: string,
  port: number,
  token: string,
  timeoutMs = 8000,
): Promise<number> {
  // IPv6 literals must be bracketed in a CONNECT target ([::1]:80).
  const target = host.includes(":") ? `[${host}]` : host;
  return new Promise((resolve, reject) => {
    const sock = netConnect(proxyPort, "127.0.0.1", () => {
      const auth = `\r\nProxy-Authorization: Basic ${Buffer.from(`srt:${token}`).toString("base64")}`;
      sock.write(`CONNECT ${target}:${port} HTTP/1.1\r\nHost: ${target}:${port}${auth}\r\n\r\n`);
    });
    const timer = setTimeout(() => { sock.destroy(); resolve(-1); }, timeoutMs);
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      if (buf.includes("\r\n\r\n")) {
        clearTimeout(timer);
        sock.destroy();
        resolve(Number(buf.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0));
      }
    });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// Manual CONNECT -> TLS -> GET /, returns the inner HTTP status (0 if the
// tunnel never opened).
function tunnelGetStatus(
  proxyPort: number,
  host: string,
  port: number,
  ca: string,
  token: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(proxyPort, "127.0.0.1", () => {
      const auth = `\r\nProxy-Authorization: Basic ${Buffer.from(`srt:${token}`).toString("base64")}`;
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}${auth}\r\n\r\n`);
    });
    let handshake = "";
    const onData = (d: Buffer) => {
      handshake += d.toString("latin1");
      if (!handshake.includes("\r\n\r\n")) return;
      sock.removeListener("data", onData);
      const connectStatus = Number(handshake.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0);
      if (connectStatus !== 200) {
        resolve(0);
        sock.end();
        return;
      }
      const tls = tlsConnect({ socket: sock, servername: host, ca }, () => {
        tls.write(`GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`);
      });
      let resp = "";
      tls.on("data", (d) => (resp += d.toString("utf8")));
      tls.on("end", () => resolve(Number(resp.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0)));
      tls.on("error", reject);
    };
    sock.on("data", onData);
    sock.on("error", reject);
  });
}
