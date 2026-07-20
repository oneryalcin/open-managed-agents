import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export const ADMIN_KEY_ENV = "OMA_ADMIN_KEY";
export const ADMIN_KEY_FILE_ENV = "OMA_ADMIN_KEY_FILE";
const ADMIN_KEY_BYTES = 32;

export interface AdminAuth {
  verify(presented: string): boolean;
  /**
   * Stable, non-secret identifier for the configured admin key. Console
   * sessions keep this digest so rotating OMA_ADMIN_KEY invalidates them.
   */
  fingerprint(): string;
}

export interface AdminKeyEnv {
  OMA_ADMIN_KEY?: string;
  OMA_ADMIN_KEY_FILE?: string;
}

export function generateAdminKey(): string {
  return randomBytes(ADMIN_KEY_BYTES).toString("base64");
}

export function loadAdminKey(
  env: AdminKeyEnv = process.env,
): string | undefined {
  const direct = env[ADMIN_KEY_ENV];
  const file = env[ADMIN_KEY_FILE_ENV];
  if (direct !== undefined && file !== undefined) {
    throw new Error(
      `set exactly one of ${ADMIN_KEY_ENV} or ${ADMIN_KEY_FILE_ENV}, not both`,
    );
  }
  if (direct === undefined && file === undefined) return undefined;
  const value =
    direct === undefined ? readFileSync(file!, "utf8").trim() : direct.trim();
  parseAdminKey(value, direct === undefined ? ADMIN_KEY_FILE_ENV : ADMIN_KEY_ENV);
  return value;
}

function parseAdminKey(value: string, source: string): void {
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length !== ADMIN_KEY_BYTES ||
    decoded.toString("base64") !== value
  ) {
    throw new Error(
      `${source} must be exactly ${ADMIN_KEY_BYTES} random bytes, ` +
        `base64-encoded (generate one with: node -e "console.log(` +
        `require('crypto').randomBytes(32).toString('base64'))")`,
    );
  }
}

export function createAdminAuth(adminKey: string): AdminAuth {
  const expectedDigest = sha256(adminKey);
  return {
    verify(presented: string): boolean {
      return timingSafeEqual(sha256(presented), expectedDigest);
    },
    fingerprint(): string {
      return expectedDigest.toString("hex");
    },
  };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
