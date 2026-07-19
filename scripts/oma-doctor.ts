import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseModelDeploymentConfigFromEnv,
  validateModelDeploymentConfigAgainstCatalog,
  type ModelDeploymentEnv,
} from "../src/control-plane/models/deployment-config.ts";
import { createReadOnlyPiModelCatalog, type ReadOnlyAuthData } from "../src/control-plane/models/catalog.ts";
import { DEFAULT_OMA_SANDBOX_IMAGE } from "../src/control-plane/sessions/pi/sandbox/image.ts";
import {
  DEFAULT_OMA_EGRESS_SIDECAR_IMAGE,
  resolveOmaUpEgressEnvironment,
} from "../src/control-plane/egress/image.ts";

type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  summary: string;
}

export interface DoctorReport {
  schema_version: 1;
  ok: boolean;
  checks: DoctorCheck[];
}

interface DoctorRuntime {
  env: NodeJS.ProcessEnv;
  nodeVersion?: string;
  command?: typeof spawnSync;
  fetch?: typeof globalThis.fetch;
}

export async function inspectOma(
  options: { sandbox: "docker-local" | "microsandbox-local" },
  runtime: DoctorRuntime = { env: process.env },
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const env = runtime.env;
  const command = runtime.command ?? spawnSync;
  const nodeVersion = runtime.nodeVersion ?? process.versions.node;
  const [major = 0, minor = 0] = nodeVersion.split(".").map(Number);
  checks.push(check(
    "node.version",
    major > 22 || (major === 22 && minor >= 19) ? "pass" : "fail",
    major > 22 || (major === 22 && minor >= 19)
      ? `Node ${nodeVersion} satisfies >=22.19.0.`
      : `Node ${nodeVersion} is too old; install Node >=22.19.0.`,
  ));

  const home = env.OMA_HOME?.trim() || join(homedir(), ".oma");
  const homePathCheck = inspectPath("paths.oma_home", home, "directory", 0o700);
  checks.push(homePathCheck);

  let deployment;
  try {
    if (homePathCheck.status === "fail") {
      throw new Error("OMA_HOME is not safe to inspect");
    }
    deployment = parseModelDeploymentConfigFromEnv(env as ModelDeploymentEnv, { home });
    const authPathCheck = inspectPath("paths.pi_auth", deployment.authPath, "file", 0o600);
    const modelsPathCheck = inspectPath("paths.pi_models", deployment.modelsPath, "file", 0o600);
    checks.push(authPathCheck, modelsPathCheck);
    if (authPathCheck.status === "fail" || modelsPathCheck.status === "fail") {
      throw new Error("Pi configuration paths are not safe to read");
    }
    const authData = readAuthSnapshot(deployment.authPath);
    const catalog = createReadOnlyPiModelCatalog({
      allowedProviders: deployment.allowedProviders,
      defaultModel: deployment.defaultModel,
      authPath: deployment.authPath,
      modelsPath: deployment.modelsPath,
      allowModelAuthCommands: deployment.allowModelAuthCommands,
    }, authData);
    validateModelDeploymentConfigAgainstCatalog(deployment, {
      hasProvider: (provider) => catalog.allowedProviders.has(provider),
      hasModel: (model) => catalog.resolve(model) !== undefined,
    });
    checks.push(check(
      "models.catalog",
      "pass",
      `${catalog.list().length} registered model(s) across ${catalog.allowedProviders.size} enabled provider(s); default ${catalog.defaultModel.provider}/${catalog.defaultModel.id}.`,
    ));
    const defaultModel = catalog.resolve(catalog.defaultModel);
    const configured = defaultModel !== undefined && catalog.hasConfiguredAuth(defaultModel);
    checks.push(check(
      "models.credentials",
      configured ? "pass" : "warn",
      configured
        ? `Credentials are configured for default model ${catalog.defaultModel.provider}/${catalog.defaultModel.id}.`
        : `Credentials are not configured for default model ${catalog.defaultModel.provider}/${catalog.defaultModel.id}; the local-compatible smoke still works, or run oma auth set ${catalog.defaultModel.provider} before a credentialed session.`,
    ));
    checks.push(check(
      "models.config",
      catalog.securityReport.warnings.length === 0 ? "pass" : "warn",
      catalog.securityReport.warnings.length === 0
        ? "Model configuration passed read-only validation."
        : `Model configuration is valid with ${catalog.securityReport.warnings.length} warning(s); run oma models validate for details.`,
    ));
  } catch (error) {
    checks.push(check("models.catalog", "fail", safeError("Model configuration is invalid", error)));
  }

  if (options.sandbox === "docker-local") {
    const info = command("docker", ["info"], { encoding: "utf8" });
    checks.push(check(
      "sandbox.runtime",
      info.status === 0 ? "pass" : "fail",
      info.status === 0 ? "Docker daemon is reachable." : "Docker daemon is unavailable; start Docker and retry.",
    ));
    const image = command("docker", ["image", "inspect", DEFAULT_OMA_SANDBOX_IMAGE], { encoding: "utf8" });
    checks.push(check(
      "sandbox.image",
      image.status === 0 ? "pass" : "warn",
      image.status === 0
        ? "The pinned OMA sandbox image is already present locally."
        : "The pinned OMA sandbox image is not present locally; oma doctor did not download it.",
    ));
    try {
      const effective = resolveOmaUpEgressEnvironment(env, "docker-local");
      if (effective.OMA_ENABLE_EGRESS === "false") {
        checks.push(check(
          "egress.sidecar",
          "warn",
          "Approved HTTPS egress is explicitly disabled; only offline environments can run.",
        ));
      } else {
        const sidecarImage = effective.OMA_EGRESS_SIDECAR_IMAGE ?? DEFAULT_OMA_EGRESS_SIDECAR_IMAGE;
        const sidecar = command("docker", ["image", "inspect", sidecarImage], { encoding:"utf8" });
        checks.push(check(
          "egress.sidecar",
          sidecar.status === 0 ? "pass" : "warn",
          sidecar.status === 0
            ? "The effective digest-pinned OMA egress sidecar is present locally."
            : "The effective digest-pinned OMA egress sidecar is not present locally; oma doctor did not download it.",
        ));
      }
    } catch (error) {
      checks.push(check("egress.sidecar", "fail", safeError("Egress configuration is invalid", error)));
    }
  } else {
    const executable = env.OMA_MICROSANDBOX_COMMAND?.trim() || "msb";
    const version = command(executable, ["--version"], { encoding: "utf8" });
    checks.push(check(
      "sandbox.runtime",
      version.status === 0 ? "pass" : "fail",
      version.status === 0 ? "Microsandbox CLI is reachable." : `Microsandbox CLI ${executable} is unavailable.`,
    ));
    checks.push(check(
      "sandbox.image",
      "warn",
      "Microsandbox image presence is not inspected in read-only mode; no image was downloaded.",
    ));
    checks.push(check(
      "egress.sidecar",
      "warn",
      "Approved HTTPS egress presets are not supported by microsandbox-local in this alpha.",
    ));
  }

  checks.push(await inspectPort(env, runtime.fetch ?? globalThis.fetch));
  return { schema_version: 1, ok: !checks.some((item) => item.status === "fail"), checks };
}

function readAuthSnapshot(path: string): ReadOnlyAuthData {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("auth.json is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("auth.json must contain an object");
  }
  for (const [provider, value] of Object.entries(parsed)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`auth.json.${provider} must contain a credential object`);
    }
    const credential = value as Record<string, unknown>;
    if (credential.type !== "api_key" && credential.type !== "oauth") {
      throw new Error(`auth.json.${provider}.type must be api_key or oauth`);
    }
    if (credential.type === "api_key" && (typeof credential.key !== "string" || credential.key.length === 0)) {
      throw new Error(`auth.json.${provider}.key must be a non-empty string`);
    }
  }
  return parsed as ReadOnlyAuthData;
}

function inspectPath(id: string, path: string, kind: "directory" | "file", expectedMode: number): DoctorCheck {
  if (!existsSync(path)) return check(id, "warn", `${path} does not exist; oma doctor left it unchanged.`);
  const lst = lstatSync(path);
  if (lst.isSymbolicLink()) return check(id, "fail", `${path} is a symlink; use an owner-controlled ${kind}.`);
  const st = statSync(path);
  const correctKind = kind === "directory" ? st.isDirectory() : st.isFile();
  if (!correctKind) return check(id, "fail", `${path} is not a ${kind}.`);
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return check(id, "fail", `${path} permissions are 0${mode.toString(8)}; expected owner-only access such as 0${expectedMode.toString(8)}.`);
  }
  return check(id, "pass", `${path} is owner-controlled.`);
}

async function inspectPort(env: NodeJS.ProcessEnv, fetchImpl: typeof globalThis.fetch): Promise<DoctorCheck> {
  const host = env.OMA_HOST?.trim() || "127.0.0.1";
  const port = Number(env.OMA_PORT?.trim() || "4180");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return check("server.port", "fail", "OMA_PORT must be an integer from 1 through 65535.");
  }
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    try {
      const response = await fetchImpl(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(750) });
      if (response.ok) return check("server.port", "pass", `OMA is already responding on ${host}:${port}.`);
    } catch {
      // A failed health request is followed by a bind-only availability test.
    }
  }
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(check("server.port", "fail", `${host}:${port} is occupied by a process that did not answer as OMA.`)));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(check("server.port", "pass", `${host}:${port} is available for oma up.`)));
    });
  });
}

function check(id: string, status: CheckStatus, summary: string): DoctorCheck {
  return { id, status, summary };
}

function safeError(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message.replace(/https?:\/\/[^\s]+/g, "[redacted-url]")}`;
}

function parseArgs(argv: string[]): { json: boolean; sandbox: "docker-local" | "microsandbox-local" } {
  let json = false;
  let sandbox: "docker-local" | "microsandbox-local" = "docker-local";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--sandbox") {
      const value = argv[++index];
      if (value === "docker" || value === "docker-local") sandbox = "docker-local";
      else if (value === "microsandbox" || value === "microsandbox-local") sandbox = "microsandbox-local";
      else throw new Error("--sandbox requires docker or microsandbox");
    } else {
      throw new Error(`Unknown option for oma doctor: ${arg}`);
    }
  }
  return { json, sandbox };
}

async function main(): Promise<void> {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`oma: ${error instanceof Error ? error.message : String(error)}\nRun \`oma doctor --help\` for usage.`);
    process.exit(2);
  }
  let report: DoctorReport;
  try {
    report = await inspectOma(options);
  } catch (error) {
    const summary = safeError("Doctor could not complete its read-only inspection", error);
    if (options.json) {
      console.log(JSON.stringify({
        schema_version: 1,
        ok: false,
        checks: [check("doctor.internal", "fail", summary)],
      } satisfies DoctorReport, null, 2));
    } else {
      console.error(`oma: ${summary}`);
    }
    process.exit(2);
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("OMA doctor (read-only)\n");
    for (const item of report.checks) console.log(`${item.status.toUpperCase().padEnd(4)} ${item.id}  ${item.summary}`);
    console.log(`\n${report.ok ? "Ready" : "Not ready"}. No files were created and no images were downloaded.`);
  }
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
