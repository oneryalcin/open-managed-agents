#!/usr/bin/env node
// Thin launcher: the server source is TypeScript with non-erasable syntax
// (constructor parameter properties), so plain type stripping fails; re-exec
// node with --experimental-transform-types, which the probe on Node 24.18
// verified boots the full deployment app.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [major = 0, minor = 0] = process.versions.node
  .split(".")
  .map((part) => Number.parseInt(part, 10));
if (major < 22 || (major === 22 && minor < 19)) {
  console.error(
    `open-managed-agents requires Node >= 22.19.0 (found ${process.versions.node})`,
  );
  process.exit(1);
}

const mainPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "main.ts",
);

const child = spawn(
  process.execPath,
  [
    "--experimental-transform-types",
    "--disable-warning=ExperimentalWarning",
    mainPath,
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);

// Forward termination when this shim is the signal target (e.g. docker stop
// or a supervisor signalling PID 1); terminal Ctrl+C already reaches the
// child via the process group.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
