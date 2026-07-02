/**
 * Probe 44: srt egress-proxy confidence probe (0114 capability track, #130).
 *
 * Question: does @anthropic-ai/sandbox-runtime's proxy stack, driven directly
 * (deep dist import, unsupported API), enforce the invariants from
 * docs/references/egress-secrets-buy-vs-build.md?
 *
 *   (a) allowlisted host works through TLS termination;
 *   (b) non-allowlisted host is denied (not tunnelled);
 *   (c) redirect to a non-allowlisted host is denied on re-entry;
 *   (d) sentinel -> real substitution happens at the boundary: the client
 *       sends the sentinel, the upstream observes the real value, and the
 *       client's environment never holds the real value (the echoed response
 *       showing it is the known reflective-upstream caveat);
 *   (e) missing proxy auth is rejected (407) - the per-session policy key;
 *   (f) documented gap: srt has no post-DNS-resolution private-IP deny
 *       (our allowlisted target IS loopback and nothing objects) - the
 *       smokescreen-style check is OMA's to add.
 *
 * Run: npx tsx scratch/44-egress-proxy-probe.ts   (requires a Docker daemon)
 *
 * The client is a real Docker container (curlimages/curl) whose ONLY egress
 * route is the proxy (HTTPS_PROXY) and whose env carries ONLY the sentinel;
 * it reaches the host proxy via host.docker.internal, with the MITM CA mounted
 * read-only. The container names "localhost" in CONNECT, but the proxy (on the
 * host) is what resolves it to the echo server — the container never reaches
 * the upstream directly.
 *
 * CLIENT DRIVER: the container runs via async `spawn`, NOT execFileSync. The
 * proxy and echo server run in THIS process; a synchronous child would block
 * the event loop so the proxy could never accept the connection (the
 * self-deadlock that the auth arc already caught once). Every await below
 * keeps the loop turning.
 *
 * Setup: a local HTTPS echo server (self-signed, CN=localhost) stands in for
 * the credentialed upstream; its cert is handed to the proxy via
 * tlsTerminateUpstreamCA (the documented test seam).
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Deep dist imports: NOT public API (see buy-vs-build survey) - probe only.
import { createHttpProxyServer } from "../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/http-proxy.js";
import {
  createMitmCA,
  disposeMitmCA,
} from "../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js";

const SENTINEL = "srt-sentinel-3f9a1c";
const REAL_SECRET = "real-secret-do-not-leak-8c4e2b";
const PROXY_TOKEN = "probe-session-token";

const results: Array<{ check: string; pass: boolean; detail: string }> = [];
function record(check: string, pass: boolean, detail: string) {
  results.push({ check, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${check} — ${detail}`);
}

const work = mkdtempSync(join(tmpdir(), "egress-probe-"));

// --- 1. HTTPS echo upstream (the controlled credentialed target) ----------
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", join(work, "echo-key.pem"),
  "-out", join(work, "echo-cert.pem"),
  "-days", "2",
  "-subj", "/CN=localhost",
  "-addext", "subjectAltName=DNS:localhost",
]);

const upstreamSeen: Array<{ path: string; authorization: string | undefined }> = [];
const echo = https.createServer(
  { key: readFileSync(join(work, "echo-key.pem")), cert: readFileSync(join(work, "echo-cert.pem")) },
  (req, res) => {
    upstreamSeen.push({ path: req.url ?? "", authorization: req.headers.authorization });
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "https://example.com/after-redirect" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, authorization: req.headers.authorization ?? null }));
  },
);
await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
const echoPort = (echo.address() as { port: number }).port;

// --- 2. srt proxy: allowlist + sentinel substitution ----------------------
const mitmCA = createMitmCA({});
const clientSentinelSightings: string[] = [];
const denials: string[] = [];

const proxy = createHttpProxyServer({
  // Hostname allowlist: only our echo target.
  filter: (port, host) => host === "localhost" && port === echoPort,
  mitmCA,
  // Full-URL policy on the decrypted request (origin+path rules are ours).
  filterRequest: async (request) => {
    const url = new URL(request.url);
    if (url.hostname === "localhost" && Number(url.port) === echoPort) {
      return { action: "allow" };
    }
    denials.push(request.url);
    return { action: "deny", reason: `policy: ${url.hostname} not allowlisted` };
  },
  // Boundary injection: replace the sentinel bearer with the real secret.
  mutateHeaders: (headers, destHost) => {
    if (destHost === "localhost" && headers.authorization === `Bearer ${SENTINEL}`) {
      clientSentinelSightings.push(String(headers.authorization));
      headers.authorization = `Bearer ${REAL_SECRET}`;
    }
  },
  tlsTerminateUpstreamCA: readFileSync(join(work, "echo-cert.pem")),
  proxyAuthToken: PROXY_TOKEN,
});
await new Promise<void>((r) => proxy.listen(0, "0.0.0.0", r));
const proxyPort = (proxy.address() as { port: number }).port;

// --- 3. Docker container as the sandboxed client --------------------------
const caPath = join(work, "mitm-ca.pem");
writeFileSync(caPath, mitmCA.certPem);
const proxyHostUrl = (withAuth: boolean) =>
  withAuth
    ? `http://srt:${PROXY_TOKEN}@host.docker.internal:${proxyPort}`
    : `http://host.docker.internal:${proxyPort}`;

// Async so the in-process proxy/echo keep serving while the container runs.
function curlClient(args: string[], withAuth = true): Promise<{ code: number; out: string }> {
  const child = spawn("docker", [
    "run", "--rm",
    "-v", `${caPath}:/ca.pem:ro`,
    // The container has ONLY the sentinel; the real secret lives solely in
    // the host proxy process. HTTPS_PROXY is the container's only egress.
    "-e", `HTTPS_PROXY=${proxyHostUrl(withAuth)}`,
    "-e", `HTTP_PROXY=${proxyHostUrl(withAuth)}`,
    "-e", `API_TOKEN=${SENTINEL}`,
    "curlimages/curl:latest",
    "--cacert", "/ca.pem", "-sS", "--max-time", "15", ...args,
  ]);
  return new Promise((resolvePromise) => {
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, out }));
  });
}

// (a) allowlisted host + (d) sentinel substitution
const allowed = await curlClient([
  "-H", `Authorization: Bearer ${SENTINEL}`,
  `https://localhost:${echoPort}/headers`,
]);
const echoBody = (() => {
  try { return JSON.parse(allowed.out) as { authorization: string | null }; }
  catch { return { authorization: `unparseable: ${allowed.out.slice(0, 120)}` }; }
})();
record(
  "(a) allowlisted host reachable via TLS termination",
  allowed.code === 0 && upstreamSeen.some((s) => s.path === "/headers"),
  `curl exit ${allowed.code}; upstream saw ${upstreamSeen.length} request(s)`,
);
record(
  "(d1) upstream observed the REAL secret",
  echoBody.authorization === `Bearer ${REAL_SECRET}`,
  `upstream authorization: ${JSON.stringify(echoBody.authorization)}`,
);
record(
  "(d2) boundary received only the SENTINEL from the container",
  clientSentinelSightings.length === 1 &&
    clientSentinelSightings[0] === `Bearer ${SENTINEL}`,
  `pre-mutation header at boundary: ${JSON.stringify(clientSentinelSightings)}`,
);
// (d3) known reflective-upstream caveat, made explicit: this echo target
// returns the substituted header, so the REAL secret DOES appear in the
// container's response body. The survey records this as inherent to boundary
// injection (srt pipes responses back unmodified); mitigations are allowlist
// trust + optional OMA response redaction. Documented, not a failure.
record(
  "(d3) reflective upstream returns the real secret in the response (expected caveat)",
  allowed.out.includes(REAL_SECRET),
  "echo reflected the injected header; non-reflective upstreams (github, etc.) do not",
);

// (b) non-allowlisted host denied
const denied = await curlClient([`https://example.com/`]);
record(
  "(b) non-allowlisted host denied",
  denied.code !== 0 && !denied.out.includes("<html"),
  `curl exit ${denied.code}; output: ${denied.out.slice(0, 100).replaceAll("\n", " ")}`,
);

// (c) redirect to non-allowlisted host denied on re-entry
const redirected = await curlClient([
  "-L", `https://localhost:${echoPort}/redirect`,
]);
record(
  "(c) redirect to non-allowlisted host denied",
  redirected.code !== 0 &&
    upstreamSeen.some((s) => s.path === "/redirect") &&
    !redirected.out.includes("after-redirect"),
  `curl exit ${redirected.code}; denials recorded: ${JSON.stringify(denials)}`,
);

// (e) missing proxy auth -> rejected (curl fails the CONNECT on 407)
const noAuth = await curlClient(
  [`https://localhost:${echoPort}/headers`],
  false,
);
record(
  "(e) missing proxy auth rejected",
  noAuth.code !== 0 && !noAuth.out.includes(REAL_SECRET),
  `curl exit ${noAuth.code}; output: ${noAuth.out.slice(0, 90).replaceAll("\n", " ")}`,
);

// (f) private-IP gap: our allowlisted target IS a loopback address and srt
// raised no objection anywhere above - post-resolution IP checks don't exist.
record(
  "(f) documented gap: no post-resolution private-IP deny in srt",
  upstreamSeen.length > 0,
  "allowlisted localhost (loopback) served fine; smokescreen-style check is OMA's to add",
);

// --- teardown --------------------------------------------------------------
await new Promise<void>((r) => proxy.close(() => r()));
await new Promise<void>((r) => echo.close(() => r()));
await disposeMitmCA(mitmCA);
rmSync(work, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
