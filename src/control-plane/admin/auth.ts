import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export const ADMIN_KEY_ENV = "OMA_ADMIN_KEY";
export const ADMIN_KEY_FILE_ENV = "OMA_ADMIN_KEY_FILE";
export const MIN_ADMIN_KEY_LENGTH = 32;

export interface AdminAuth {
  verify(presented: string): boolean;
}

export interface AdminKeyEnv {
  OMA_ADMIN_KEY?: string;
  OMA_ADMIN_KEY_FILE?: string;
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
  if (value.length < MIN_ADMIN_KEY_LENGTH) {
    throw new Error(
      `${direct === undefined ? ADMIN_KEY_FILE_ENV : ADMIN_KEY_ENV} must be at least ` +
        `${MIN_ADMIN_KEY_LENGTH} characters`,
    );
  }
  return value;
}

export function createAdminAuth(adminKey: string): AdminAuth {
  const expectedDigest = sha256(adminKey);
  return {
    verify(presented: string): boolean {
      return timingSafeEqual(sha256(presented), expectedDigest);
    },
  };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
