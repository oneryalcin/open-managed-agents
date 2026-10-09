import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchWebResource } from "../guarded-fetch.ts";
import type { WebUrlCheck } from "../web-url.ts";

// Plan 0149: the web tools' fetch follows redirects itself so every hop goes
// through the URL validator, and caps time and bytes while streaming.

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// Loopback http fixtures stand in for allowed https hosts; the real validator
// is covered in web-url.test.ts.
const allowLoopback = { allowAddress: (address: string) => address === "127.0.0.1" };
const allowAll = (raw: string): WebUrlCheck => ({ ok: true, url: new URL(raw) });

describe("guarded web fetch", () => {
  it("follows a relative redirect to the final page", async () => {
    const base = await serve((req, res) => {
      if (req.url === "/old") res.writeHead(301, { location: "/new" }).end();
      else res.writeHead(200, { "content-type": "text/plain" }).end(`page ${req.url}`);
    });

    const result = await fetchWebResource(`${base}/old`, { validate: allowAll, guard: allowLoopback });

    expect(result.ok && [result.finalUrl, new TextDecoder().decode(result.body)]).toEqual([`${base}/new`, "page /new"]);
  });

  it("does not dial a redirect target the validator refuses", async () => {
    let targetHits = 0;
    const target = await serve((_req, res) => {
      targetHits += 1;
      res.end("secret");
    });
    const start = await serve((_req, res) => res.writeHead(302, { location: `${target}/x` }).end());
    const validate = (raw: string): WebUrlCheck =>
      raw.startsWith(start)
        ? { ok: true, url: new URL(raw) }
        : { ok: false, code: "url_not_allowed", reason: "not allowed" };

    const result = await fetchWebResource(`${start}/`, { validate, guard: allowLoopback });

    expect([result.ok ? "ok" : result.code, targetHits]).toEqual(["url_not_allowed", 0]);
  });

  it("reports a malformed redirect Location instead of throwing", async () => {
    const base = await serve((_req, res) => res.writeHead(302, { location: "https://[" }).end());

    const result = await fetchWebResource(`${base}/`, { validate: allowAll, guard: allowLoopback });

    expect(result.ok ? "ok" : result.code).toBe("invalid_url");
  });

  it("gives up after five redirects", async () => {
    const base = await serve((req, res) => {
      const n = Number(req.url?.slice(1) ?? 0);
      res.writeHead(302, { location: `/${n + 1}` }).end();
    });

    const result = await fetchWebResource(`${base}/0`, { validate: allowAll, guard: allowLoopback });

    expect(result.ok ? "ok" : result.code).toBe("too_many_redirects");
  });

  it("cuts a streamed body off at the byte cap", async () => {
    // Chunked, no Content-Length: only a streaming cap can stop it.
    const big = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("y".repeat(50_000));
    });

    const result = await fetchWebResource(`${big}/`, { validate: allowAll, guard: allowLoopback, maxBytes: 1_000 });

    expect(result.ok && [result.body.length, result.truncated]).toEqual([1_000, true]);
  });

  it("times out a server that never finishes", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
    });

    const result = await fetchWebResource(`${base}/`, { validate: allowAll, guard: allowLoopback, timeoutMs: 200 });

    expect(result.ok ? "ok" : result.code).toBe("timeout");
  });

  it("stops when the caller aborts", async () => {
    const base = await serve(() => {});
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await fetchWebResource(`${base}/`, { validate: allowAll, guard: allowLoopback, signal: controller.signal });

    expect(result.ok ? "ok" : result.code).toBe("aborted");
  });

  it("still applies the SSRF guard to an allowed URL", async () => {
    const base = await serve((_req, res) => res.end("internal"));

    const result = await fetchWebResource(`${base}/`, { validate: allowAll });

    expect(result.ok ? "ok" : result.code).toBe("url_not_allowed");
  });
});
