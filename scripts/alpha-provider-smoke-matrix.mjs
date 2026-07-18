#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LIVE_PROVIDER_SMOKE_LANES } from "./alpha-smoke-models.mjs";

const omaCli = fileURLToPath(new URL("../bin/oma.mjs", import.meta.url));
const requested = parseRequestedProviders(process.env.OMA_ALPHA_PROVIDER_LANES);

console.log("\nOMA provider smoke matrix\n=========================");
if (requested === undefined || requested.has("local-compatible")) {
  await runLane("local-compatible", ["smoke", "--local-compatible"], process.env);
} else {
  console.log("- skip local-compatible: not listed in OMA_ALPHA_PROVIDER_LANES");
}

for (const lane of LIVE_PROVIDER_SMOKE_LANES) {
  const explicitlyRequested = requested?.has(lane.provider) === true;
  const credential = process.env[lane.credentialEnv];
  if (!credential) {
    if (explicitlyRequested) {
      throw new Error(`${lane.provider} smoke requested but ${lane.credentialEnv} is not set`);
    }
    console.log(`- skip ${lane.provider}: ${lane.credentialEnv} is not set`);
    continue;
  }
  if (requested !== undefined && !explicitlyRequested) {
    console.log(`- skip ${lane.provider}: not listed in OMA_ALPHA_PROVIDER_LANES`);
    continue;
  }
  const model = process.env[lane.modelEnv] ?? lane.defaultModel;
  await runLane(lane.provider, ["smoke"], {
    ...process.env,
    OMA_ALPHA_MODEL_PROVIDER: lane.provider,
    OMA_ALPHA_MODEL: model,
    OMA_MODEL_PROVIDERS: lane.provider,
    OMA_DEFAULT_MODEL_PROVIDER: lane.provider,
    OMA_DEFAULT_MODEL: model,
  });
}

console.log("\nProvider smoke matrix passed.");

async function runLane(name, args, env) {
  console.log(`\n→ ${name}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [omaCli, ...args], {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (status, signal) => {
      if (signal !== null) reject(new Error(`${name} smoke terminated by ${signal}`));
      else resolve(status ?? 1);
    });
  });
  if (code !== 0) throw new Error(`${name} smoke failed with exit code ${code}`);
}

function parseRequestedProviders(value) {
  if (value === undefined) return undefined;
  const names = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (names.length === 0) throw new Error("OMA_ALPHA_PROVIDER_LANES must not be empty");
  const known = new Set(["local-compatible", ...LIVE_PROVIDER_SMOKE_LANES.map((lane) => lane.provider)]);
  for (const name of names) {
    if (!known.has(name)) throw new Error(`Unknown provider smoke lane ${JSON.stringify(name)}`);
  }
  return new Set(names);
}
