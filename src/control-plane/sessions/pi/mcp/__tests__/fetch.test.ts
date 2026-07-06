// Plan 0122 §4.3/§5 — SSRF property tests for the guarded MCP fetch.
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGuardedMcpFetch } from "../fetch.ts";

let server: Server;
let baseUrl: string;
const requests: string[] = [];

beforeEach(async () => {
  requests.length = 0;
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === "/redir") {
      res.writeHead(302, { location: `${baseUrl}/private` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(() => {
  server.close();
});

async function fetchCauseCode(promise: Promise<Response>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    const withCode = error as { code?: unknown; cause?: { code?: unknown } };
    return withCode.code ?? withCode.cause?.code ?? (error as Error).message;
  }
}

describe("createGuardedMcpFetch (plan 0122 §4.3)", () => {
  it("blocks loopback targets with the guard active", async () => {
    const guarded = createGuardedMcpFetch();
    expect(await fetchCauseCode(guarded(`${baseUrl}/`))).toBe(
      "EGRESS_SSRF_BLOCKED",
    );
    expect(requests).toEqual([]);
  });

  it("reaches the fixture through the allowAddress test seam", async () => {
    const guarded = createGuardedMcpFetch({ allowAddress: () => true });
    const response = await guarded(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("re-consults the guard on every new connection (rebinding property)", async () => {
    // First resolution allowed, any later one refused — models DNS rebinding
    // to a blocked range after the first check. The guard must run per
    // resolution, not once per hostname.
    let resolutions = 0;
    const guarded = createGuardedMcpFetch({
      allowAddress: () => {
        resolutions += 1;
        return resolutions === 1;
      },
    });
    const first = await guarded(`${baseUrl}/`, {
      headers: { connection: "close" },
    });
    expect(first.status).toBe(200);
    expect(await fetchCauseCode(guarded(`${baseUrl}/`))).toBe(
      "EGRESS_SSRF_BLOCKED",
    );
  });

  it("refuses redirects even when the caller asks to follow them", async () => {
    const guarded = createGuardedMcpFetch({ allowAddress: () => true });
    await expect(
      guarded(`${baseUrl}/redir`, { redirect: "follow" }),
    ).rejects.toThrow();
    // The redirect target was never fetched.
    expect(requests).toEqual(["GET /redir"]);
  });

  it("guards GET requests identically (SSE channel uses the same fetch)", async () => {
    const guarded = createGuardedMcpFetch();
    expect(
      await fetchCauseCode(guarded(`${baseUrl}/sse`, { method: "GET" })),
    ).toBe("EGRESS_SSRF_BLOCKED");
    expect(requests).toEqual([]);
  });
});

describe("hostname path through the undici pinned-lookup dispatcher (review 0122-M1)", () => {
  // IP-literal targets short-circuit at assertLiteralHostAllowed; `localhost`
  // is a HOSTNAME, so these cases force Node through the dispatcher's
  // connect.lookup — the actual anti-rebinding mechanism for real MCP URLs.
  function localhostUrl(): string {
    return baseUrl.replace("127.0.0.1", "localhost");
  }

  it("blocks a hostname resolving to loopback via the dispatcher lookup", async () => {
    const guarded = createGuardedMcpFetch();
    expect(await fetchCauseCode(guarded(`${localhostUrl()}/`))).toBe(
      "EGRESS_SSRF_BLOCKED",
    );
    expect(requests).toEqual([]);
  });

  it("reaches the fixture by hostname through the seam (lookup ran, SNI host preserved)", async () => {
    const guarded = createGuardedMcpFetch({ allowAddress: () => true });
    const response = await guarded(`${localhostUrl()}/`, {
      headers: { connection: "close" },
    });
    expect(response.status).toBe(200);
    await response.text(); // release the socket so afterEach can close the server
  });

  it("re-consults the guard per hostname resolution (rebinding, dispatcher path)", async () => {
    let resolutions = 0;
    const guarded = createGuardedMcpFetch({
      allowAddress: () => {
        resolutions += 1;
        return resolutions <= 2; // lookup sees v4+v6 candidates on call 1
      },
    });
    const first = await guarded(`${localhostUrl()}/`, {
      headers: { connection: "close" },
    });
    expect(first.status).toBe(200);
    await first.text(); // release the socket so afterEach can close the server
    expect(await fetchCauseCode(guarded(`${localhostUrl()}/`))).toBe(
      "EGRESS_SSRF_BLOCKED",
    );
  });
});
