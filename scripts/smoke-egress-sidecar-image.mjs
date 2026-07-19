#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const image = process.argv[2];
if (!image) {
  console.error("usage: node scripts/smoke-egress-sidecar-image.mjs IMAGE");
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "oma-egress-image-smoke-"));
const shared = join(root, "shared");
const bundle = join(root, "bundle.json");
const name = `oma-egress-image-smoke-${process.pid}`;
const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const gid = typeof process.getgid === "function" ? process.getgid() : 0;

try {
  spawnOrThrow("mkdir", [shared]);
  writeFileSync(bundle, JSON.stringify({
    listenPort:8080,
    proxyAuthToken:"smoke-token-not-a-secret",
    policy:{ allow:[], credentials:[] },
    grants:[],
    secrets:{},
  }), { mode:0o600 });
  chmodSync(shared, 0o700);
  const run = spawnSync("docker", [
    "run", "-d", "--name", name,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--user", `${uid}:${gid}`,
    "-p", "127.0.0.1::8080",
    "-v", `${shared}:/shared`,
    "-v", `${bundle}:/bundle.json:ro`,
    "-e", "OMA_EGRESS_BUNDLE_PATH=/bundle.json",
    "-e", "OMA_EGRESS_SHARED_DIR=/shared",
    image,
  ], { encoding:"utf8" });
  if (run.status !== 0) throw new Error(run.stderr || run.stdout);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const ready = spawnSync("test", ["-f", join(shared, "ready")]);
    if (ready.status === 0) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  const cert = readFileSync(join(shared, "ca.crt"), "utf8");
  if (!cert.includes("BEGIN CERTIFICATE")) throw new Error("sidecar did not publish a CA certificate");
  if (spawnSync("test", ["-f", join(shared, "ready")]).status !== 0) {
    throw new Error("sidecar did not publish readiness");
  }
  const published = spawnSync("docker", ["port", name, "8080/tcp"], { encoding:"utf8" });
  if (published.status !== 0) throw new Error(published.stderr || published.stdout);
  const port = Number.parseInt(published.stdout.trim().split(":").at(-1) ?? "", 10);
  if (!Number.isSafeInteger(port) || port <= 0) throw new Error(`invalid published proxy port: ${published.stdout.trim()}`);
  const denied = await proxyRequest(port, "smoke-token-not-a-secret");
  if (denied.status !== 403 || !denied.body.includes("network allowlist")) {
    throw new Error(`sidecar did not enforce authenticated default deny: ${denied.status} ${denied.body}`);
  }
  console.log(`egress sidecar smoke passed: ${image}`);
} finally {
  spawnSync("docker", ["rm", "-f", name], { stdio:"ignore" });
  rmSync(root, { recursive:true, force:true });
}

function proxyRequest(port, token) {
  return new Promise((resolve, reject) => {
    const req = request({
      host:"127.0.0.1",
      port,
      method:"GET",
      path:"http://example.com/",
      headers:{
        "proxy-authorization": `Basic ${Buffer.from(`srt:${token}`).toString("base64")}`,
      },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status:response.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function spawnOrThrow(command, args) {
  const result = spawnSync(command, args, { encoding:"utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
