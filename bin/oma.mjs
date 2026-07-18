#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);

checkNode();

const command = args[0];
if (command === undefined || command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}
if (command === "version" || command === "--version" || command === "-v") {
  console.log(`oma ${packageJson.version}`);
  process.exit(0);
}
if (command === "up") {
  await runUp(args.slice(1));
} else if (command === "smoke") {
  await runSmoke(args.slice(1));
} else if (command === "keys") {
  await runKeys(args.slice(1));
} else if (command === "workspaces") {
  await runWorkspaces(args.slice(1));
} else if (command === "admin") {
  runAdmin(args.slice(1));
} else if (command === "providers") {
  await runProviders(args.slice(1));
} else if (command === "models") {
  await runModels(args.slice(1));
} else if (command === "auth") {
  await runAuth(args.slice(1));
} else if (command === "down" || command === "logs" || command === "status") {
  fail(`${command} is not implemented yet. Run \`oma up\` in the foreground and use Ctrl-C to stop it.`);
} else {
  fail(`Unknown command: ${command}\n\nRun \`oma --help\` for usage.`);
}

async function runUp(commandArgs) {
  let sandbox = "docker-local";
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index];
    if (arg === "--sandbox") {
      const value = commandArgs[index + 1];
      if (value === undefined) fail("--sandbox requires docker or microsandbox");
      sandbox = normalizeSandbox(value);
      index += 1;
      continue;
    }
    if (arg === "--detach" || arg === "-d") {
      fail("Detached mode is not implemented yet. Run `oma up` in the foreground for now.");
    }
    fail(`Unknown option for oma up: ${arg}`);
  }

  checkSandbox(sandbox);
  const sandboxEnv = sandbox === "docker-local"
    ? { OMA_SANDBOX_PROVIDER: sandbox, OMA_ALLOW_DOCKER_LOCAL: "true" }
    : { OMA_SANDBOX_PROVIDER: sandbox, OMA_ALLOW_MICROSANDBOX_LOCAL: "true" };

  const adminEnv = resolveAdminEnvironment();
  console.log(`Starting OMA with ${sandbox}`);
  if (adminEnv.OMA_ADMIN_KEY_FILE !== undefined) {
    console.log(`Admin mode: ${adminEnv.OMA_ADMIN_KEY_FILE}`);
  } else if (process.env.OMA_ADMIN_KEY !== undefined) {
    console.log("Admin mode: OMA_ADMIN_KEY environment variable");
  }
  console.log("Press Ctrl-C to stop. Durable data defaults to ~/.oma.\n");
  await runChild(
    process.execPath,
    [
      "--experimental-transform-types",
      "--disable-warning=ExperimentalWarning",
      join(root, "src", "main.ts"),
    ],
    { ...process.env, ...sandboxEnv, ...adminEnv },
  );
}

function runAdmin(commandArgs) {
  const [action, ...rest] = commandArgs;
  if (action === "init") {
    let path = defaultAdminKeyPath();
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index];
      if (arg === "--file") {
        path = requiredOption(rest, ++index, arg);
      } else {
        fail(`Unknown option for oma admin init: ${arg}`);
      }
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const key = randomBytes(32).toString("base64");
    try {
      writeFileSync(path, `${key}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      chmodSync(path, 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail(`Admin key file already exists at ${path}. Refusing to overwrite it.`);
      }
      throw error;
    }
    console.log(`Admin key initialized at ${path}`);
    console.log(`Admin key: ${key}`);
    console.log("This key grants appliance-wide administration. Store it securely.");
    console.log("Restart `oma up` to enable console admin mode.");
    return;
  }
  if (action === "status") {
    if (rest.length !== 0) fail("Usage: oma admin status");
    if (process.env.OMA_ADMIN_KEY !== undefined && process.env.OMA_ADMIN_KEY !== "") {
      console.log("Admin mode is configured through OMA_ADMIN_KEY.");
      return;
    }
    const path = defaultAdminKeyPath();
    if (!existsSync(path)) {
      console.log(`Admin mode is not configured. Run \`oma admin init\` to create ${path}.`);
      return;
    }
    const mode = statSync(path).mode & 0o777;
    console.log(`Admin key file: ${path}`);
    console.log(`Permissions: ${mode.toString(8).padStart(3, "0")}`);
    console.log("Admin mode will be enabled the next time `oma up` starts.");
    return;
  }
  if (action === "rotate") {
    fail("Admin key rotation is not implemented yet. Preserve the existing key file.");
  }
  fail("Usage: oma admin <init|status>");
}

async function runKeys(commandArgs) {
  const [action, ...rest] = commandArgs;
  if (action !== "mint" && action !== "list") {
    fail("Usage: oma keys <mint|list> [--workspace id] [--label label] [--db path]");
  }
  let workspace = "wrk_default";
  let label = "oma-cli";
  let db = defaultDatabasePath();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--workspace") {
      workspace = requiredOption(rest, ++index, arg);
    } else if (arg === "--label" && action === "mint") {
      label = requiredOption(rest, ++index, arg);
    } else if (arg === "--db") {
      db = requiredOption(rest, ++index, arg);
    } else {
      fail(`Unknown option for oma keys ${action}: ${arg}`);
    }
  }
  const provisioningArgs = action === "mint"
    ? ["mint-key", workspace, label, "--db", db]
    : ["list-keys", workspace, "--db", db];
  await runProvisioning(provisioningArgs);
}

async function runWorkspaces(commandArgs) {
  const [action, ...rest] = commandArgs;
  if (action !== "list") fail("Usage: oma workspaces list [--db path]");
  let db = defaultDatabasePath();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--db") {
      db = requiredOption(rest, ++index, arg);
    } else {
      fail(`Unknown option for oma workspaces list: ${arg}`);
    }
  }
  await runProvisioning(["list-workspaces", "--db", db]);
}

async function runProviders(commandArgs) {
  const [action, ...rest] = commandArgs;
  if (action !== "status") fail("Usage: oma providers status");
  if (rest.length !== 0) fail("Usage: oma providers status");
  await runModelProvisioning(["providers-status"]);
}

async function runModels(commandArgs) {
  const [action, ...rest] = commandArgs;
  if (action === "list") {
    await runModelProvisioning(["models-list", ...rest]);
    return;
  }
  if (action === "validate") {
    await runModelProvisioning(["models-validate", ...rest]);
    return;
  }
  fail("Usage: oma models <list|validate>");
}

async function runAuth(commandArgs) {
  const [action, ...rest] = commandArgs;
  if (action === "set") {
    await runModelProvisioning(["auth-set", ...rest]);
    return;
  }
  if (action === "remove") {
    await runModelProvisioning(["auth-remove", ...rest]);
    return;
  }
  if (action === "status") {
    await runModelProvisioning(["auth-status", ...rest]);
    return;
  }
  fail("Usage: oma auth <set|remove|status>");
}

async function runProvisioning(provisioningArgs) {
  await runChild(
    process.execPath,
    [
      "--experimental-transform-types",
      "--disable-warning=ExperimentalWarning",
      join(root, "scripts", "oma-workspaces.ts"),
      ...provisioningArgs,
    ],
    process.env,
  );
}

async function runModelProvisioning(provisioningArgs) {
  await runChild(
    process.execPath,
    [
      "--experimental-transform-types",
      "--disable-warning=ExperimentalWarning",
      join(root, "scripts", "oma-models.ts"),
      ...provisioningArgs,
    ],
    process.env,
  );
}

async function runSmoke(commandArgs) {
  let sandbox;
  let localCompatible = false;
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index];
    if (arg === "--sandbox") {
      const value = commandArgs[index + 1];
      if (value === undefined) fail("--sandbox requires docker or microsandbox");
      sandbox = normalizeSandbox(value);
      index += 1;
      continue;
    }
    if (arg === "--local-compatible") {
      localCompatible = true;
      continue;
    }
    fail(`Unknown option for oma smoke: ${arg}`);
  }
  await runChild(
    process.execPath,
    [join(root, "scripts", "alpha-smoke.mjs")],
    {
      ...process.env,
      ...(sandbox === undefined ? {} : { OMA_ALPHA_SANDBOX_PROVIDER: sandbox }),
      ...(localCompatible ? { OMA_ALPHA_LOCAL_COMPATIBLE: "1" } : {}),
    },
  );
}

function requiredOption(args, index, option) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) fail(`${option} requires a value`);
  return value;
}

function defaultDatabasePath() {
  return process.env.OMA_SQLITE_PATH ?? join(defaultOmaHome(), "oma.sqlite");
}

function defaultOmaHome() {
  return process.env.OMA_HOME ?? join(homedir(), ".oma");
}

function defaultAdminKeyPath() {
  return process.env.OMA_ADMIN_KEY_FILE ?? join(defaultOmaHome(), "admin.key");
}

function resolveAdminEnvironment() {
  if (process.env.OMA_ADMIN_KEY !== undefined || process.env.OMA_ADMIN_KEY_FILE !== undefined) return {};
  const path = defaultAdminKeyPath();
  return existsSync(path) ? { OMA_ADMIN_KEY_FILE: path } : {};
}

function normalizeSandbox(value) {
  if (value === "docker" || value === "docker-local") return "docker-local";
  if (value === "microsandbox" || value === "microsandbox-local") return "microsandbox-local";
  fail(`Unsupported sandbox ${JSON.stringify(value)}. Use docker or microsandbox.`);
}

function checkSandbox(sandbox) {
  if (sandbox === "docker-local") {
    const result = spawnSync("docker", ["info"], { encoding: "utf8" });
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "docker info failed").trim();
      fail(`Docker is required for \`oma up\`. Start Docker and retry.\n${detail}`);
    }
    return;
  }
  const command = process.env.OMA_MICROSANDBOX_COMMAND ?? "msb";
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `${command} --version failed`).trim();
    fail(`Microsandbox is required for \`oma up --sandbox microsandbox\`.\n${detail}`);
  }
}

function runChild(command, childArgs, env) {
  return new Promise((resolve) => {
    const child = spawn(command, childArgs, { cwd: root, env, stdio: "inherit" });
    const onSigint = () => child.exitCode === null && child.kill("SIGINT");
    const onSigterm = () => child.exitCode === null && child.kill("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    child.on("exit", (code, signal) => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      if (signal !== null) {
        process.exit(signal === "SIGINT" ? 130 : 143);
      }
      if ((code ?? 0) !== 0) process.exit(code ?? 1);
      resolve();
    });
  });
}

function checkNode() {
  const [major = 0, minor = 0] = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
  if (major < 22 || (major === 22 && minor < 19)) {
    fail(`oma requires Node >= 22.19.0 (found ${process.versions.node})`);
  }
}

function printHelp() {
  console.log(`Open Managed Agents CLI

Usage:
  oma up [--sandbox docker|microsandbox]
  oma smoke [--sandbox docker|microsandbox] [--local-compatible]
  oma keys mint [--workspace id] [--label label]
  oma keys list [--workspace id]
  oma workspaces list
  oma providers status
  oma models list [--provider name] [--available]
  oma models validate [--file path]
  oma auth set <provider> [--stdin]
  oma auth status [provider]
  oma auth remove <provider>
  oma admin init
  oma admin status
  oma version
  oma help

Commands:
  up       Start the durable local appliance in the foreground. Docker is the default.
  smoke      Run the disposable end-to-end alpha smoke test.
  keys       Mint or list workspace API keys in the local appliance database.
  workspaces  List local appliance workspaces.
  providers   Inspect enabled Pi model providers and credential readiness.
  models      List or validate enabled Pi models.
  auth        Store, remove, or inspect model provider API-key credentials.
  admin       Initialize or inspect local appliance admin mode.
  version     Print the installed OMA version.

Environment:
  ANTHROPIC_API_KEY       Anthropic model credential used by the control plane.
  OMA_MODEL_PROVIDERS     Enabled provider allowlist (default: anthropic).
  OMA_DEFAULT_MODEL_PROVIDER / OMA_DEFAULT_MODEL
                           Default exact model pair.
  OMA_ALPHA_MODEL_PROVIDER / OMA_ALPHA_MODEL
                           Exact provider/model used by oma smoke.
  OMA_PI_AUTH_FILE        Pi auth storage path (default: $OMA_HOME/pi/auth.json).
  OMA_PI_MODELS_FILE      Pi models.json path (default: $OMA_HOME/pi/models.json).
  OMA_HOME                Durable data directory (default: ~/.oma).
  OMA_HOST                Bind address (default: 127.0.0.1).
  OMA_PORT                Listen port (default: 4180).

Planned, not implemented yet:
  oma up --detach
  oma status
  oma logs
  oma down
  oma admin rotate`);
}

function fail(message) {
  console.error(`oma: ${message}`);
  process.exit(2);
}
