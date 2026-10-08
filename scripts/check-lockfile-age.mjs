#!/usr/bin/env node
// Supply-chain gate (ADR 0017): every package version a change adds to
// package-lock.json must be at least MIN_AGE_DAYS old. `npm ci` installs
// lockfile entries without re-checking min-release-age, so this is what
// enforces the policy on pull requests.
//
// Usage: node scripts/check-lockfile-age.mjs <base-ref>
// Overrides: list "name@version" lines in .lockfile-age-allow, each justified
// in an ADR per ADR 0006's process.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const MIN_AGE_DAYS = 2;
const baseRef = process.argv[2];
if (!baseRef) {
  console.error("usage: check-lockfile-age.mjs <base-ref>");
  process.exit(2);
}

function versions(lockText) {
  const out = new Set();
  for (const [path, entry] of Object.entries(JSON.parse(lockText).packages ?? {})) {
    if (!path || entry.link || !entry.version || !entry.resolved?.startsWith("https://registry.npmjs.org/")) continue;
    out.add(`${entry.name ?? path.split("node_modules/").pop()}@${entry.version}`);
  }
  return out;
}

const base = versions(execFileSync("git", ["show", `${baseRef}:package-lock.json`], { encoding: "utf8" }));
const head = versions(readFileSync("package-lock.json", "utf8"));
const allowed = new Set(
  existsSync(".lockfile-age-allow")
    ? readFileSync(".lockfile-age-allow", "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    : [],
);
const added = [...head].filter((spec) => !base.has(spec) && !allowed.has(spec));

const now = Date.now();
const tooYoung = [];
for (const spec of added) {
  const at = spec.lastIndexOf("@");
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`);
  if (!res.ok) throw new Error(`registry lookup failed for ${name}: HTTP ${res.status}`);
  const published = (await res.json()).time?.[version];
  if (!published) throw new Error(`no publish time for ${spec}`);
  const ageDays = (now - Date.parse(published)) / 86_400_000;
  if (ageDays < MIN_AGE_DAYS) tooYoung.push(`${spec} (published ${published}, ${ageDays.toFixed(1)} days old)`);
}

console.log(`checked ${added.length} added/changed package version(s) against ${baseRef}`);
if (tooYoung.length > 0) {
  console.error(`Lockfile adds versions younger than ${MIN_AGE_DAYS} days (ADR 0017):\n  ${tooYoung.join("\n  ")}`);
  process.exit(1);
}
