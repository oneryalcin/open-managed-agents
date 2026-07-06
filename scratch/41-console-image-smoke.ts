/**
 * Probe 41 — appliance-image console smoke (plan 0120 §6).
 *
 * The gap this locks: local vitest serves the console from the checkout, so
 * it can pass while the shipped Docker image silently lacks ui/ (the exact
 * failure the review caught — .dockerignore excluded ui, COPY would ship
 * nothing). This smoke builds the real image, boots the real container, and
 * asserts the console actually serves from it:
 *
 *   - GET /console        -> 301 /console/
 *   - GET /console/       -> 200 text/html, no-store, CSP present
 *   - GET /console/vendor/react.production.min.js -> 200 (vendored, no CDN)
 *   - GET /console/..%2f..%2fpackage.json         -> 404 (traversal guard)
 *   - GET /v1/agents      -> 401 (API routed, auth on)
 *
 * Deterministic, no model calls. Needs Docker. Run:
 *   make console-image-smoke
 */
import { execFileSync, spawnSync } from "node:child_process";

const IMAGE = "oma-console-smoke";
const NAME = `oma-console-smoke-${process.pid}`;

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

async function main(): Promise<void> {
  console.log("[1/3] docker build …");
  sh("docker", ["build", "-q", "-t", IMAGE, "."]);

  console.log("[2/3] boot container …");
  // -P publishes 4180 on an ephemeral host port; auth stays on (api-key) but
  // no admin key, so no transport-gate opt-in is needed.
  sh("docker", ["run", "-d", "--rm", "--name", NAME, "-P", IMAGE]);
  try {
    const portLine = sh("docker", ["port", NAME, "4180/tcp"]).trim().split("\n")[0]!;
    const base = `http://127.0.0.1:${portLine.split(":").pop()}`;

    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) {
      ready = await fetch(`${base}/console/`).then((r) => r.ok, () => false);
      if (!ready) await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready) throw new Error(`container never served /console/ at ${base}`);

    console.log("[3/3] assertions …");
    const checks: Array<[string, (r: Response) => Promise<boolean> | boolean]> = [
      ["/console", (r) => r.status === 301 && r.headers.get("location") === "/console/"],
      ["/console/", async (r) =>
        r.status === 200 &&
        (r.headers.get("content-type") ?? "").startsWith("text/html") &&
        r.headers.get("cache-control") === "no-store" &&
        (r.headers.get("content-security-policy") ?? "").includes("connect-src 'self'") &&
        (await r.text()).includes("Managed Agents Console")],
      ["/console/vendor/react.production.min.js", (r) => r.status === 200],
      ["/console/src/app.jsx", (r) =>
        r.status === 200 && (r.headers.get("content-type") ?? "").startsWith("text/babel")],
      ["/console/..%2f..%2fpackage.json", (r) => r.status === 404],
      ["/v1/agents", (r) => r.status === 401],
    ];
    for (const [path, check] of checks) {
      const res = await fetch(`${base}${path}`, { redirect: "manual" });
      if (!(await check(res))) {
        throw new Error(`FAIL ${path}: status=${res.status} ct=${res.headers.get("content-type")}`);
      }
      console.log(`  ok ${path}`);
    }
    console.log("console-image-smoke: PASS");
  } finally {
    spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
  }
}

await main();
