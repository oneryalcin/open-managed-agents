import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createHttpProxyServer,
  createMitmCA,
  disposeMitmCA,
  type MitmCA,
} from "../proxy.ts";

// Contract test for the vendored srt egress proxy (plan 0117a). Exercises the
// vendored code in CI without Docker: an in-process TLS echo upstream, the
// proxy, and a dep-free manual CONNECT+TLS tunnel client. This is the in-suite
// counterpart to scratch/44 (which uses a real container). Carries the
// load-bearing invariants — allowlist, sentinel->real substitution, path deny,
// proxy auth, verify-before-inject — so a bad re-pin of the vendor fails here.

const SENTINEL = "Bearer sent-xyz";
const REAL = "Bearer real-xyz";
const TOKEN = "session-token";

interface TunnelResult {
  connectStatus: number;
  httpStatus: number;
  body: string;
}

// Manual CONNECT -> (on 200) TLS over the tunnel -> GET. Resolves with the
// CONNECT status and, if the tunnel opened, the inner HTTP status + body.
function tunnelGet(
  proxyPort: number,
  host: string,
  port: number,
  ca: string,
  headers: Record<string, string>,
  token: string | undefined,
): Promise<TunnelResult> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(proxyPort, "127.0.0.1", () => {
      const auth = token
        ? `\r\nProxy-Authorization: Basic ${Buffer.from(`srt:${token}`).toString("base64")}`
        : "";
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}${auth}\r\n\r\n`);
    });
    let handshake = "";
    const onData = (d: Buffer) => {
      handshake += d.toString("latin1");
      if (!handshake.includes("\r\n\r\n")) return;
      sock.removeListener("data", onData);
      const connectStatus = Number(handshake.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0);
      if (connectStatus !== 200) {
        resolve({ connectStatus, httpStatus: 0, body: handshake });
        sock.end();
        return;
      }
      const tls = tlsConnect({ socket: sock, servername: host, ca }, () => {
        const hdrs = Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n");
        const sep = hdrs ? `${hdrs}\r\n` : "";
        tls.write(`GET / HTTP/1.1\r\nHost: ${host}:${port}\r\n${sep}Connection: close\r\n\r\n`);
      });
      let resp = "";
      tls.on("data", (d) => (resp += d.toString("utf8")));
      tls.on("end", () => {
        const httpStatus = Number(resp.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0);
        resolve({ connectStatus, httpStatus, body: resp.split("\r\n\r\n").slice(1).join("\r\n\r\n") });
      });
      tls.on("error", reject);
    };
    sock.on("data", onData);
    sock.on("error", reject);
  });
}

describe("vendored egress proxy contract (plan 0117a)", () => {
  let work: string;
  let echo: Server;
  let echoPort: number;
  let proxy: ReturnType<typeof createHttpProxyServer>;
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

    ca = createMitmCA({});
    proxy = createHttpProxyServer({
      filter: (port, host) => host === "localhost" && port === echoPort,
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

  it("allows an allowlisted host and substitutes sentinel->real at the boundary", async () => {
    const res = await tunnelGet(proxyPort, "localhost", echoPort, ca.certPem, { Authorization: SENTINEL }, TOKEN);
    expect(res.httpStatus).toBe(200);
    // Upstream saw the REAL secret; the client only ever sent the sentinel.
    expect(res.body).toContain(REAL);
    expect(upstreamSeen.at(-1)).toBe(REAL);
  });

  it("denies a non-allowlisted host at CONNECT (403)", async () => {
    const res = await tunnelGet(proxyPort, "example.com", 443, ca.certPem, {}, TOKEN);
    expect(res.connectStatus).toBe(403);
    expect(res.httpStatus).toBe(0); // tunnel never opened
  });

  it("denies a disallowed path via filterRequest inside the tunnel (403)", async () => {
    const before = upstreamSeen.length;
    const res = await tunnelGet(proxyPort, "localhost", echoPort, ca.certPem, { Authorization: SENTINEL }, TOKEN);
    // NOTE: this hits "/", which is allowed; the /blocked case is next.
    expect(res.httpStatus).toBe(200);
    const blocked = await tunnelBlockedPath(proxyPort, "localhost", echoPort, ca.certPem, TOKEN);
    expect(blocked).toBe(403);
    expect(upstreamSeen.length).toBe(before + 1); // only the allowed "/" reached upstream
  });

  it("rejects a missing proxy-auth token (407)", async () => {
    const res = await tunnelGet(proxyPort, "localhost", echoPort, ca.certPem, {}, undefined);
    expect(res.connectStatus).toBe(407);
  });
});

// Small variant that requests /blocked and returns the inner HTTP status.
function tunnelBlockedPath(
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
      const tls = tlsConnect({ socket: sock, servername: host, ca }, () => {
        tls.write(`GET /blocked HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`);
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
