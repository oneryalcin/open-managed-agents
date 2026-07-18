import type { AuthStorageBackend } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

type LockResult<T> = { result: T; next?: string };

export interface OmaAuthStorageBackendOptions {
  staleMs?: number;
  syncRetryAttempts?: number;
  syncRetryDelayMs?: number;
  asyncRetries?: number;
  /** Test seam for crash-window proof; production leaves this undefined. */
  beforeRename?: () => void;
}

const DEFAULT_AUTH_JSON = "{}";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const DEFAULT_STALE_MS = 30_000;

export class OmaAuthStorageBackend implements AuthStorageBackend {
  readonly authPath: string;
  private readonly staleMs: number;
  private readonly syncRetryAttempts: number;
  private readonly syncRetryDelayMs: number;
  private readonly asyncRetries: number;
  private readonly beforeRename: (() => void) | undefined;

  constructor(authPath: string, options: OmaAuthStorageBackendOptions = {}) {
    this.authPath = resolve(authPath);
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.syncRetryAttempts = options.syncRetryAttempts ?? 50;
    this.syncRetryDelayMs = options.syncRetryDelayMs ?? 20;
    this.asyncRetries = options.asyncRetries ?? 10;
    this.beforeRename = options.beforeRename;
  }

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    this.prepareStorage();
    let release: (() => void) | undefined;
    try {
      release = this.acquireLockSync();
      this.assertSafeAuthFile();
      const current = readFileSync(this.authPath, "utf8");
      const { result, next } = fn(current);
      if (next !== undefined) {
        this.atomicWrite(next);
      }
      return result;
    } finally {
      release?.();
    }
  }

  async withLockAsync<T>(
    fn: (current: string | undefined) => Promise<LockResult<T>>,
  ): Promise<T> {
    this.prepareStorage();
    let release: (() => Promise<void>) | undefined;
    let compromised: Error | undefined;
    const throwIfCompromised = () => {
      if (compromised) {
        throw compromised;
      }
    };
    try {
      release = await lockfile.lock(this.authPath, {
        realpath: false,
        stale: this.staleMs,
        retries: {
          retries: this.asyncRetries,
          factor: 2,
          minTimeout: 25,
          maxTimeout: 250,
          randomize: true,
        },
        onCompromised: (error) => {
          compromised = error;
        },
      });
      throwIfCompromised();
      this.assertSafeAuthFile();
      const current = readFileSync(this.authPath, "utf8");
      const { result, next } = await fn(current);
      throwIfCompromised();
      if (next !== undefined) {
        this.atomicWrite(next);
      }
      throwIfCompromised();
      return result;
    } finally {
      if (release) {
        try {
          await release();
        } catch {
          if (!compromised) {
            throw new Error("Failed to release auth storage lock");
          }
        }
      }
    }
  }

  private prepareStorage(): void {
    const dir = dirname(this.authPath);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    this.assertSafeDirectory(dir);
    if (!existsSync(this.authPath)) {
      this.createInitialFile();
    }
    this.assertSafeAuthFile();
  }

  private createInitialFile(): void {
    try {
      const fd = openSync(this.authPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(), FILE_MODE);
      try {
        writeFileSync(fd, DEFAULT_AUTH_JSON, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(this.authPath, FILE_MODE);
      this.fsyncParent();
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        return;
      }
      throw error;
    }
  }

  private acquireLockSync(): () => void {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.syncRetryAttempts; attempt += 1) {
      try {
        return lockfile.lockSync(this.authPath, {
          realpath: false,
          stale: this.staleMs,
        });
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ELOCKED" || attempt === this.syncRetryAttempts) {
          throw error;
        }
        lastError = error;
        sleepSync(this.syncRetryDelayMs);
      }
    }
    throw lastError ?? new Error("Failed to acquire auth storage lock");
  }

  private atomicWrite(content: string): void {
    const dir = dirname(this.authPath);
    const temp = resolve(dir, `.${basenameForTemp(this.authPath)}.${process.pid}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(), FILE_MODE);
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      chmodSync(temp, FILE_MODE);
      this.beforeRename?.();
      renameSync(temp, this.authPath);
      chmodSync(this.authPath, FILE_MODE);
      this.assertSafeAuthFile();
      this.fsyncParent();
    } catch (error) {
      if (fd !== undefined) {
        closeSync(fd);
      }
      try {
        unlinkSync(temp);
      } catch {
        // Best effort cleanup; failing here would hide the original error.
      }
      throw error;
    }
  }

  private assertSafeDirectory(path: string): void {
    const lst = lstatSync(path);
    if (lst.isSymbolicLink()) {
      throw new Error(`Refusing to use symlinked auth directory: ${path}`);
    }
    const st = statSync(path);
    if (!st.isDirectory()) {
      throw new Error(`Auth storage parent is not a directory: ${path}`);
    }
    assertOwned(path, st.uid, "auth directory");
    const mode = st.mode & 0o777;
    if (mode !== DIR_MODE) {
      throw new Error(`Refusing unsafe auth directory permissions ${formatMode(mode)} for ${path}; expected 0700`);
    }
  }

  private assertSafeAuthFile(): void {
    const lst = lstatSync(this.authPath);
    if (lst.isSymbolicLink()) {
      throw new Error(`Refusing to use symlinked auth file: ${this.authPath}`);
    }
    const st = statSync(this.authPath);
    if (!st.isFile()) {
      throw new Error(`Auth storage path is not a regular file: ${this.authPath}`);
    }
    assertOwned(this.authPath, st.uid, "auth file");
    const mode = st.mode & 0o777;
    if (mode !== FILE_MODE) {
      throw new Error(`Refusing unsafe auth file permissions ${formatMode(mode)} for ${this.authPath}; expected 0600`);
    }
  }

  private fsyncParent(): void {
    const fd = openSync(dirname(this.authPath), constants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

export function createOmaAuthStorageBackend(
  authPath: string,
  options?: OmaAuthStorageBackendOptions,
): OmaAuthStorageBackend {
  return new OmaAuthStorageBackend(authPath, options);
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function sleepSync(delayMs: number): void {
  const start = Date.now();
  while (Date.now() - start < delayMs) {
    // Busy wait preserves Pi's synchronous backend contract.
  }
}

function basenameForTemp(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

function assertOwned(path: string, uid: number, label: string): void {
  if (typeof process.getuid !== "function") {
    return;
  }
  const currentUid = process.getuid();
  if (uid !== currentUid) {
    throw new Error(`Refusing ${label} not owned by current user: ${path}`);
  }
}

function formatMode(mode: number): string {
  return `0${mode.toString(8).padStart(3, "0")}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
