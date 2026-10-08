import type { CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

// Pi 0.80.8 stopped exporting AuthStorage; ModelRuntime now takes any
// CredentialStore. These are the shapes it expects, typed from Pi's own
// options so no second copy of @earendil-works/pi-ai is needed.
export type PiCredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;
export type PiModelsStore = NonNullable<CreateModelRuntimeOptions["modelsStore"]>;
type Credential = NonNullable<Awaited<ReturnType<PiCredentialStore["read"]>>>;
type CredentialInfo = Awaited<ReturnType<PiCredentialStore["list"]>>[number];
type AuthOperationOptions = Parameters<PiCredentialStore["read"]>[1];
type ModelsStoreEntry = NonNullable<Awaited<ReturnType<PiModelsStore["read"]>>>;

export type AuthStorageData = Record<string, Credential>;

type LockResult<T> = { result: T; next?: string };

/** Serialized read-modify-write over the raw auth.json bytes. */
export interface AuthStorageBackend {
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
  withLockAsync<T>(
    fn: (current: string | undefined) => Promise<LockResult<T>>,
  ): Promise<T>;
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
  private content: string | undefined;

  constructor(data?: AuthStorageData) {
    if (data !== undefined) this.content = JSON.stringify(data, null, 2);
  }

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    const { result, next } = fn(this.content);
    if (next !== undefined) this.content = next;
    return result;
  }

  async withLockAsync<T>(
    fn: (current: string | undefined) => Promise<LockResult<T>>,
  ): Promise<T> {
    const { result, next } = await fn(this.content);
    if (next !== undefined) this.content = next;
    return result;
  }
}

/**
 * Pi CredentialStore over an AuthStorageBackend, mirroring Pi's (no longer
 * exported) AuthStorage: same auth.json schema, every access goes through the
 * backend lock, and api-key values are resolved on read. Unlike Pi's store it
 * does not swallow a corrupt auth.json; a server should fail loudly.
 */
/**
 * How "!command" api-key values are treated on read:
 * - "deny": reject them. auth.json is re-read per request, so the startup
 *   policy scan alone cannot stop a key written after startup;
 * - "execute": run them (OMA_ALLOW_MODEL_AUTH_COMMANDS=true);
 * - "unresolved": return them unexecuted, for read-only diagnostics.
 */
export type CredentialCommandPolicy = "deny" | "execute" | "unresolved";

export class OmaCredentialStore implements PiCredentialStore {
  private inflightRead: Promise<AuthStorageData> | undefined;
  private readonly commands: CredentialCommandPolicy;

  constructor(
    private readonly backend: AuthStorageBackend,
    options: { commands?: CredentialCommandPolicy } = {},
  ) {
    this.commands = options.commands ?? "deny";
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    const credential = (await this.readAll(options))[providerId];
    if (credential?.type !== "api_key" || credential.key === undefined) return credential;
    if (credential.key.startsWith("!")) {
      if (this.commands === "unresolved") return credential;
      if (this.commands === "deny") {
        throw new Error(
          `auth.json.${providerId}.key uses command-backed auth; set OMA_ALLOW_MODEL_AUTH_COMMANDS=true to allow it`,
        );
      }
    }
    return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return Object.entries(await this.readAll(options)).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return this.backend.withLockAsync(async (content) => {
      const data = parseAuthData(content);
      const next = await fn(data[providerId]);
      if (next === undefined) return { result: data[providerId] };
      return { result: next, next: JSON.stringify({ ...data, [providerId]: next }, null, 2) };
    });
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    await this.backend.withLockAsync(async (content) => {
      const data = parseAuthData(content);
      delete data[providerId];
      return { result: undefined, next: JSON.stringify(data, null, 2) };
    });
  }

  // Pi's availability refresh reads every provider in parallel; concurrent
  // readers share one locked read instead of contending for the file lock.
  private readAll(options?: AuthOperationOptions): Promise<AuthStorageData> {
    options?.signal?.throwIfAborted();
    this.inflightRead ??= this.backend
      .withLockAsync(async (content) => ({ result: parseAuthData(content) }))
      .finally(() => {
        this.inflightRead = undefined;
      });
    return this.inflightRead;
  }
}

/**
 * OMA never enables Pi's network model catalogs, so the cache Pi would keep
 * in models-store.json is unnecessary; an in-memory store avoids creating
 * that file next to models.json (Pi's file stores create on first lock).
 */
export class InMemoryModelsStore implements PiModelsStore {
  private readonly entries = new Map<string, ModelsStoreEntry>();

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    return this.entries.get(providerId);
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    this.entries.set(providerId, entry);
  }

  async delete(providerId: string): Promise<void> {
    this.entries.delete(providerId);
  }
}

function parseAuthData(content: string | undefined): AuthStorageData {
  if (!content) return {};
  return JSON.parse(content.replace(/^﻿/, "")) as AuthStorageData;
}

// ---------------------------------------------------------------------------
// Config-value resolution, ported from Pi's core/resolve-config-value.ts
// (MIT, (c) Mario Zechner; unchanged from 0.80.6 through 0.85.1) because Pi no
// longer exports it. Semantics:
// - "!cmd" runs cmd in a shell and uses trimmed stdout (cached per process);
//   OMA only admits these when OMA_ALLOW_MODEL_AUTH_COMMANDS=true
//   (config-security.ts);
// - "$VAR" / "${VAR}" interpolate the environment ("$$" and "$!" escape);
// - anything else is a literal.
// Omitted: Pi's Windows configured-shell path; OMA does not target Windows.
// ---------------------------------------------------------------------------

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const commandResultCache = new Map<string, string | undefined>();

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

export function resolveConfigValue(config: string, env?: Record<string, string>): string | undefined {
  if (config.startsWith("!")) return executeCommand(config);
  let resolved = "";
  for (const part of parseTemplate(config)) {
    if (part.type === "literal") {
      resolved += part.value;
      continue;
    }
    const value = env?.[part.name] || process.env[part.name] || undefined;
    if (value === undefined) return undefined;
    resolved += value;
  }
  return resolved;
}

function parseTemplate(config: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  const literal = (value: string) => {
    if (!value) return;
    const last = parts[parts.length - 1];
    if (last?.type === "literal") last.value += value;
    else parts.push({ type: "literal", value });
  };
  let index = 0;
  while (index < config.length) {
    const dollar = config.indexOf("$", index);
    if (dollar < 0) {
      literal(config.slice(index));
      break;
    }
    literal(config.slice(index, dollar));
    const next = config[dollar + 1];
    if (next === "$" || next === "!") {
      literal(next);
      index = dollar + 2;
      continue;
    }
    if (next === "{") {
      const end = config.indexOf("}", dollar + 2);
      if (end < 0) {
        literal("$");
        index = dollar + 1;
        continue;
      }
      const name = config.slice(dollar + 2, end);
      if (ENV_VAR_NAME_RE.test(name)) parts.push({ type: "env", name });
      else literal(config.slice(dollar, end + 1));
      index = end + 1;
      continue;
    }
    const match = config.slice(dollar + 1).match(ENV_VAR_NAME_PREFIX_RE);
    if (match) {
      parts.push({ type: "env", name: match[0] });
      index = dollar + 1 + match[0].length;
      continue;
    }
    literal("$");
    index = dollar + 1;
  }
  return parts;
}

function executeCommand(config: string): string | undefined {
  if (commandResultCache.has(config)) return commandResultCache.get(config);
  let result: string | undefined;
  try {
    result = execSync(config.slice(1), {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    result = undefined;
  }
  commandResultCache.set(config, result);
  return result;
}
