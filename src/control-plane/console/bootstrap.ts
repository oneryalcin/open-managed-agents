import { createHash, randomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 2 * 60 * 1000;

interface BootstrapGrant {
  workspaceKey: string;
  expiresAt: number;
}

/**
 * Process-local bearer grants used only to exchange the onboarding browser
 * handoff for the ordinary opaque console cookie. Grants are never persisted,
 * are stored by hash, and are removed before their workspace key is returned.
 */
export class ConsoleBootstrapService {
  private readonly grants = new Map<string, BootstrapGrant>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  issue(workspaceKey: string): string {
    const nonce = `ocb_${randomBytes(32).toString("base64url")}`;
    this.grants.set(hash(nonce), {
      workspaceKey,
      expiresAt: this.now() + this.ttlMs,
    });
    return nonce;
  }

  consume(nonce: string): string | undefined {
    const key = hash(nonce);
    const grant = this.grants.get(key);
    // Delete before validating/returning so every attempted consumption is
    // terminal, including an expired grant or an invalid downstream key.
    this.grants.delete(key);
    if (grant === undefined || grant.expiresAt <= this.now()) return undefined;
    return grant.workspaceKey;
  }

  clear(): void {
    this.grants.clear();
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
