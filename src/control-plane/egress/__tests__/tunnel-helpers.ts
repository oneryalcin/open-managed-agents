// Dep-free manual proxy clients for egress tests: CONNECT + TLS-over-tunnel
// HTTP (the sandbox-client shape the proxy terminates), and a raw-bytes
// CONNECT for opaque-tunnel behavior. Kept out of the test files so the
// vendor contract test (0117a) and the policy e2e (0117c) share one client.
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

export interface TunnelResult {
  connectStatus: number;
  httpStatus: number;
  body: string;
}

export interface TunnelRequestOptions {
  proxyPort: number;
  host: string;
  port: number;
  /** CA the tunnel client trusts for the proxy's terminated leg. */
  ca: string;
  headers?: Record<string, string>;
  /** Proxy-Authorization bearer; omit to send no proxy auth. */
  token?: string;
  method?: string;
  path?: string;
}

// Manual CONNECT -> (on 200) TLS over the tunnel -> one HTTP request.
// Resolves with the CONNECT status and, if the tunnel opened, the inner HTTP
// status + body.
export function tunnelRequest(
  opts: TunnelRequestOptions,
): Promise<TunnelResult> {
  const method = opts.method ?? "GET";
  const path = opts.path ?? "/";
  return new Promise((resolve, reject) => {
    const sock = netConnect(opts.proxyPort, "127.0.0.1", () => {
      const auth = opts.token
        ? `\r\nProxy-Authorization: Basic ${Buffer.from(`srt:${opts.token}`).toString("base64")}`
        : "";
      sock.write(
        `CONNECT ${opts.host}:${opts.port} HTTP/1.1\r\nHost: ${opts.host}:${opts.port}${auth}\r\n\r\n`,
      );
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
      const tls = tlsConnect({ socket: sock, servername: opts.host, ca: opts.ca }, () => {
        const hdrs = Object.entries(opts.headers ?? {})
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n");
        const sep = hdrs ? `${hdrs}\r\n` : "";
        tls.write(
          `${method} ${path} HTTP/1.1\r\nHost: ${opts.host}:${opts.port}\r\n${sep}Connection: close\r\n\r\n`,
        );
      });
      let resp = "";
      tls.on("data", (d) => (resp += d.toString("utf8")));
      tls.on("end", () => {
        const httpStatus = Number(resp.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0);
        resolve({
          connectStatus,
          httpStatus,
          body: resp.split("\r\n\r\n").slice(1).join("\r\n\r\n"),
        });
      });
      // The proxy may hard-destroy the tunnel (policy kill); surface that as
      // a failed inner request rather than a test-crashing rejection.
      tls.on("error", () => resolve({ connectStatus, httpStatus: 0, body: resp }));
    };
    sock.on("data", onData);
    sock.on("error", reject);
  });
}

export interface RawTunnelResult {
  connectStatus: number;
  /** Bytes received after sending the payload ("" if the tunnel was killed). */
  response: string;
  /** True when the proxy closed the socket on us. */
  closed: boolean;
}

// CONNECT, then write raw (non-TLS) bytes into the tunnel. Exercises the
// opaque-tunnel gate: a flagged host echoes, an unflagged host gets killed.
export function rawTunnel(opts: {
  proxyPort: number;
  host: string;
  port: number;
  token: string;
  payload: string;
  /** How long to collect echo bytes before resolving. */
  settleMs?: number;
}): Promise<RawTunnelResult> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(opts.proxyPort, "127.0.0.1", () => {
      const auth = `\r\nProxy-Authorization: Basic ${Buffer.from(`srt:${opts.token}`).toString("base64")}`;
      sock.write(
        `CONNECT ${opts.host}:${opts.port} HTTP/1.1\r\nHost: ${opts.host}:${opts.port}${auth}\r\n\r\n`,
      );
    });
    let handshake = "";
    let response = "";
    let connectStatus = 0;
    let tunneled = false;
    const settle = opts.settleMs ?? 300;
    let timer: NodeJS.Timeout | undefined;
    sock.on("data", (d: Buffer) => {
      if (!tunneled) {
        handshake += d.toString("latin1");
        if (!handshake.includes("\r\n\r\n")) return;
        connectStatus = Number(handshake.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0);
        tunneled = true;
        if (connectStatus !== 200) {
          resolve({ connectStatus, response: "", closed: true });
          sock.end();
          return;
        }
        sock.write(opts.payload);
        timer = setTimeout(() => {
          resolve({ connectStatus, response, closed: false });
          sock.destroy();
        }, settle);
        return;
      }
      response += d.toString("utf8");
    });
    sock.on("close", () => {
      if (timer) clearTimeout(timer);
      resolve({ connectStatus, response, closed: true });
    });
    sock.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (connectStatus === 0) reject(err);
      else resolve({ connectStatus, response, closed: true });
    });
  });
}
