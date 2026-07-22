import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

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
  private authority?: { workspaceKey: string; controlTokenHash: Buffer };

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

  bindResumeAuthority(workspaceKey: string, controlToken: string): void {
    this.authority = {
      workspaceKey,
      controlTokenHash: digest(controlToken),
    };
  }

  issueForControlToken(controlToken: string): string | undefined {
    if (this.authority === undefined) return undefined;
    const candidate = digest(controlToken);
    if (!timingSafeEqual(candidate, this.authority.controlTokenHash)) return undefined;
    return this.issue(this.authority.workspaceKey);
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
    this.authority = undefined;
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
