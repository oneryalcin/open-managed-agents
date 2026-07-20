#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const tsc = spawnSync(process.execPath, [
  join(root, "node_modules", "typescript", "bin", "tsc"),
  "--project",
  join(root, "tsconfig.package.json"),
], {
  cwd: root,
  stdio: "inherit",
});
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

await Promise.all([
  copyConsole(),
  cp(join(root, "ui", "openapi-docs"), join(dist, "ui", "openapi-docs"), { recursive: true }),
  ...[
    "alpha-smoke.mjs",
    "alpha-openai-compatible-fixture.mjs",
    "alpha-smoke-models.mjs",
  ].map((file) => cp(join(root, "scripts", file), join(dist, "scripts", file))),
]);

async function copyConsole() {
  await cp(
    join(root, "ui", "managed-agents-console"),
    join(dist, "ui", "managed-agents-console"),
    {
      recursive: true,
      filter(source) {
        return !source.split(sep).includes("__tests__");
      },
    },
  );
}
