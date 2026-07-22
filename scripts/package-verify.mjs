#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), "oma-package-verify-"));
const npmCache = join(temporary, "npm-cache");
const packageHome = join(temporary, "oma-home");
let tarball;

try {
  run(process.execPath, [join(root, "scripts", "package-build.mjs")], { cwd: root });
  const packed = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], { cwd: root });
  const [metadata] = JSON.parse(packed.stdout);
  tarball = join(temporary, metadata.filename);
  assertCuratedFiles(metadata.files.map((file) => file.path));

  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: temporary,
  });

  const oma = join(temporary, "node_modules", ".bin", "oma");
  const version = run(oma, ["--version"], { cwd: temporary });
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (version.stdout.trim() !== `oma ${packageJson.version}`) {
    throw new Error(`Packed CLI reported ${JSON.stringify(version.stdout.trim())}, not oma ${packageJson.version}`);
  }

  const onboardHelp = run(oma, ["help", "onboard"], { cwd: temporary });
  if (!onboardHelp.stdout.includes("Usage: oma onboard")) {
    throw new Error("Packed oma CLI did not include onboarding help.");
  }

  const doctor = run(oma, ["doctor", "--sandbox", "microsandbox", "--json"], {
    cwd: temporary,
    env: { OMA_HOME: packageHome, OMA_MICROSANDBOX_COMMAND: "oma-command-that-does-not-exist" },
    allowFailure: true,
  });
  const report = JSON.parse(doctor.stdout);
  if (report.schema_version !== 1 || !Array.isArray(report.checks)) {
    throw new Error("Packed oma doctor did not produce the documented JSON report.");
  }
  if (existsSync(packageHome)) throw new Error("Packed oma doctor created OMA_HOME; it must be read-only.");

  console.log("Package closure verified: curated tarball installs and runs oma --version and oma doctor.");
} finally {
  if (tarball !== undefined) rmSync(tarball, { force: true });
  rmSync(temporary, { recursive: true, force: true });
}

function assertCuratedFiles(files) {
  const required = [
    "bin/oma.mjs",
    "dist/src/main.js",
    "dist/scripts/oma-doctor.js",
    "dist/scripts/oma-onboard.js",
    "dist/ui/managed-agents-console/index.html",
    "dist/ui/openapi-docs/index.html",
  ];
  for (const file of required) {
    if (!files.includes(file)) throw new Error(`Packed artifact is missing ${file}.`);
  }
  for (const file of files) {
    if (/^(?:bin\/oma\.mjs|dist\/.*|LICENSE|README\.md|package\.json)$/.test(file)) continue;
    throw new Error(`Packed artifact contains an uncurated file: ${file}`);
  }
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...options.env, npm_config_cache: npmCache },
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}
