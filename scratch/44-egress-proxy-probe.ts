/**
 * Probe 44: srt egress-proxy confidence probe (0114 capability track, #130).
 *
 * Question: does @anthropic-ai/sandbox-runtime's proxy stack, driven directly
 * (deep dist import, unsupported API), enforce the invariants from
 * docs/references/egress-secrets-buy-vs-build.md?
 *
 *   (a) allowlisted host works through TLS termination;
 *   (b) non-allowlisted host is denied at CONNECT (403);
 *   (b2) allowlisted host + disallowed PATH denied by filterRequest (403);
 *   (c) redirect to a non-allowlisted host is denied on re-entry (403);
 *   (d1/d2) sentinel -> real substitution at the boundary: upstream observes
 *       the real value; the boundary saw only the sentinel; container env holds
 *       only the sentinel;
 *   (e) missing proxy auth is rejected (407);
 *   (g) verify-before-inject: a wrong upstream CA fails (502) and the secret
 *       never leaves (echo never sees it).
 *   NOTES (printed, not counted): (d3) reflective upstream echoes the secret
 *       back — inherent caveat; and srt has no post-DNS private-IP deny
 *       (allowlisted loopback served) — connect-to-pinned-IP is OMA's to add.
 *
 * Run: npx tsx scratch/44-egress-proxy-probe.ts   (requires a Docker daemon)
 *
 * The client is a real Docker container (curlimages/curl) CONFIGURED to use
 * the proxy (HTTPS_PROXY) and whose env carries ONLY the sentinel; it reaches
 * the host proxy via host.docker.internal, with the MITM CA mounted read-only.
 * The container names "localhost" in CONNECT, but the proxy (on the host) is
 * what resolves it to the echo server.
 *
 * SCOPE LIMIT: this container uses DEFAULT docker networking, so it is NOT
 * route-confined — a non-compliant client could ignore HTTPS_PROXY and egress
 * directly (verified: `docker run curl https://example.com` returns 200 with
 * no proxy). This probe validates the PROXY's behavior for a compliant client;
 * route-level confinement (the `--network none` -> proxy-only-egress shape) is
 * ADR 0016 implementation work, not what is validated here.
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
  // Path "/blocked" is denied even on the allowlisted host, so the
  // filterRequest DENY branch is actually exercised (check b2).
  filterRequest: async (request) => {
    const url = new URL(request.url);
    const onAllowedHost = url.hostname === "localhost" && Number(url.port) === echoPort;
    if (onAllowedHost && url.pathname !== "/blocked") {
      return { action: "allow" };
    }
    denials.push(request.url);
    const why = onAllowedHost ? `path ${url.pathname} blocked` : `${url.hostname} not allowlisted`;
    return { action: "deny", reason: `policy: ${why}` };
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
const proxyHostUrl = (withAuth: boolean, port = proxyPort) =>
  withAuth
    ? `http://srt:${PROXY_TOKEN}@host.docker.internal:${port}`
    : `http://host.docker.internal:${port}`;

// Async so the in-process proxy/echo keep serving while the container runs.
function curlClient(
  args: string[],
  withAuth = true,
  port = proxyPort,
): Promise<{ code: number; out: string }> {
  const child = spawn("docker", [
    "run", "--rm",
    "-v", `${caPath}:/ca.pem:ro`,
    // The container has ONLY the sentinel; the real secret lives solely in
    // the host proxy process. HTTPS_PROXY configures curl to use the proxy
    // (not route confinement — see SCOPE LIMIT in the header).
    "-e", `HTTPS_PROXY=${proxyHostUrl(withAuth, port)}`,
    "-e", `HTTP_PROXY=${proxyHostUrl(withAuth, port)}`,
    "-e", `API_TOKEN=${SENTINEL}`,
    "curlimages/curl@sha256:7c12af72ceb38b7432ab85e1a265cff6ae58e06f95539d539b654f2cfa64bb13",
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
// (d3) reflective-upstream caveat, made explicit and printed as a NOTE (not a
// counted enforcement check — it's a PASS that fires *because* the secret
// leaks back through a reflective echo). This echo returns the substituted
// header, so the REAL secret DOES appear in the container's response body. The
// survey records this as inherent to boundary injection (srt pipes responses
// back unmodified); mitigations are path/method-scoped inject grants + optional
// OMA response redaction.
console.log(
  `\nNOTE (d3): the reflective echo returned the injected secret in the ` +
    `response body (present=${allowed.out.includes(REAL_SECRET)}) — inherent to ` +
    `boundary injection; non-reflective upstreams (github, etc.) do not.`,
);

// (b) non-allowlisted host denied. Assert the explicit 403 CONNECT denial:
// only the proxy's policy branch emits it, and the proxy rejects the CONNECT
// at the hostname filter *before* example.com is ever resolved — so a
// DNS/network/TLS failure (which yields a different curl error, not
// "response 403") cannot satisfy this. That closes the false-green Codex
// flagged.
const denied = await curlClient([`https://example.com/`]);
record(
  "(b) non-allowlisted host denied by policy (403)",
  denied.code !== 0 && denied.out.includes("403") && !denied.out.includes("<html"),
  `curl exit ${denied.code}; output: ${denied.out.slice(0, 100).replaceAll("\n", " ")}`,
);

// (b2) allowlisted HOST but disallowed PATH denied inside the tunnel by
// filterRequest — exercises the per-request-policy DENY branch (which (b)/(c)
// never reach, since they're denied at the CONNECT hostname filter). The
// CONNECT succeeds, so the deny is a 403 *inside* the tunnel (curl exit 0):
// capture the HTTP status with -w, and filterRequest records the URL.
const pathDenied = await curlClient([
  "-o", "/dev/null", "-w", "%{http_code}", `https://localhost:${echoPort}/blocked`,
]);
record(
  "(b2) allowlisted host + disallowed path denied by filterRequest (403)",
  pathDenied.out.includes("403") && denials.some((u) => u.endsWith("/blocked")),
  `http_code=${pathDenied.out.trim()}; filterRequest denials: ${JSON.stringify(denials)}`,
);

// (c) redirect to non-allowlisted host denied on re-entry. Require: the echo
// served the first hop (/redirect), the follow-up CONNECT to example.com is
// denied with an explicit 403 (proving re-evaluation, not a generic failure),
// and the redirect target body was never reached.
const redirected = await curlClient([
  "-L", `https://localhost:${echoPort}/redirect`,
]);
record(
  "(c) redirect to non-allowlisted host denied by policy (403) on re-entry",
  redirected.code !== 0 &&
    upstreamSeen.some((s) => s.path === "/redirect") &&
    redirected.out.includes("403") &&
    !redirected.out.includes("after-redirect"),
  `curl exit ${redirected.code}; output: ${redirected.out.slice(0, 100).replaceAll("\n", " ")}`,
);

// (e) missing proxy auth -> rejected. Assert the explicit 407 (only the
// proxy's auth branch emits it) plus no secret leak, so an infra failure
// can't false-green.
const noAuth = await curlClient(
  [`https://localhost:${echoPort}/headers`],
  false,
);
record(
  "(e) missing proxy auth rejected (407)",
  noAuth.code !== 0 && noAuth.out.includes("407") && !noAuth.out.includes(REAL_SECRET),
  `curl exit ${noAuth.code}; output: ${noAuth.out.slice(0, 90).replaceAll("\n", " ")}`,
);

// (g) verify-before-inject: srt's upstream leg is cert-verified BEFORE mutated
// headers leave (ADR §3's most safety-critical claim). Negative test: a second
// proxy whose upstream CA is a fresh, DISTINCT bogus CA that never signed the
// echo cert. The tunnel establishes (host allowed), the upstream TLS verify
// fails, and the proxy returns 502 inside the tunnel. Load-bearing proof: the
// echo NEVER receives the request (upstream request bytes are written only
// after `secureConnect`, which never fires on a cert mismatch) — the mutated
// header (real secret) is never sent to the unverified peer — AND the proxy
// returns an explicit 502 (positive marker, so a second-proxy startup/curl
// failure can't false-green). Check (a) is the correct-CA counterpart (echo
// receives it, 200), so the differential is present in the probe.
const bogusCA = createMitmCA({}); // distinct from mitmCA and from the echo cert
const wrongCaProxy = createHttpProxyServer({
  filter: (port, host) => host === "localhost" && port === echoPort,
  mitmCA,
  filterRequest: async () => ({ action: "allow" }),
  mutateHeaders: (headers, destHost) => {
    if (destHost === "localhost" && headers.authorization === `Bearer ${SENTINEL}`) {
      headers.authorization = `Bearer ${REAL_SECRET}`;
    }
  },
  tlsTerminateUpstreamCA: bogusCA.certPem, // deliberately never signed the echo cert
  proxyAuthToken: PROXY_TOKEN,
});
await new Promise<void>((r) => wrongCaProxy.listen(0, "0.0.0.0", r));
const wrongCaPort = (wrongCaProxy.address() as { port: number }).port;
const echoSeenBefore = upstreamSeen.length;
const wrongCa = await curlClient(
  [
    "-H", `Authorization: Bearer ${SENTINEL}`,
    "-o", "/dev/null", "-w", "%{http_code}",
    `https://localhost:${echoPort}/headers`,
  ],
  true,
  wrongCaPort,
);
record(
  "(g) verify-before-inject: wrong upstream CA -> 502, secret never leaves",
  upstreamSeen.length === echoSeenBefore &&
    wrongCa.out.includes("502") &&
    !wrongCa.out.includes("200"),
  `http_code=${wrongCa.out.trim()}; echo requests still ${upstreamSeen.length} (was ${echoSeenBefore})`,
);

// NOTE (not an enforcement check): srt has no post-resolution private-IP deny —
// the allowlisted loopback target was served with no objection. A confirmed
// gap, not a proof.
console.log(
  `\nNOTE: srt served the allowlisted loopback target with no private-IP ` +
    `objection (upstream saw ${upstreamSeen.length} reqs) — no SSRF/private-IP ` +
    `deny exists; OMA must add the smokescreen-style check.`,
);

// --- teardown --------------------------------------------------------------
await new Promise<void>((r) => wrongCaProxy.close(() => r()));
await new Promise<void>((r) => proxy.close(() => r()));
await new Promise<void>((r) => echo.close(() => r()));
await disposeMitmCA(mitmCA);
await disposeMitmCA(bogusCA);
rmSync(work, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
