// Master-key loading contract (ADR 0016 §4). The key is exactly 32 random
// bytes, base64-encoded, supplied via OMA_MASTER_KEY (the value) or
// OMA_MASTER_KEY_FILE (path to a file holding the value — the docker-compose
// secrets idiom). Anything else is refused: HKDF is not a password KDF, and a
// low-entropy passphrase here would make the DB offline-brute-forceable.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { MASTER_KEY_BYTES } from "./envelope.ts";

export const MASTER_KEY_ENV = "OMA_MASTER_KEY";
export const MASTER_KEY_FILE_ENV = "OMA_MASTER_KEY_FILE";

// Fresh base64 master key, for first-run instructions and docs.
export function generateMasterKey(): string {
  return randomBytes(MASTER_KEY_BYTES).toString("base64");
}

// Strict parse: canonical base64 of exactly 32 bytes. Buffer.from(_, "base64")
// is lenient (ignores junk, tolerates truncation), so we require the decoded
// bytes to re-encode to the exact input — this rejects passphrases, hex, and
// mangled keys instead of silently deriving from garbage.
export function parseMasterKey(value: string, source: string): Buffer {
  const trimmed = value.trim();
  const decoded = Buffer.from(trimmed, "base64");
  if (
    decoded.length !== MASTER_KEY_BYTES ||
    decoded.toString("base64") !== trimmed
  ) {
    throw new Error(
      `${source} must be exactly ${MASTER_KEY_BYTES} random bytes, ` +
        `base64-encoded (generate one with: node -e "console.log(` +
        `require('crypto').randomBytes(32).toString('base64'))")`,
    );
  }
  return decoded;
}

export function loadMasterKey(
  env: Record<string, string | undefined> = process.env,
): Buffer {
  const direct = env[MASTER_KEY_ENV];
  const file = env[MASTER_KEY_FILE_ENV];
  if (direct !== undefined && file !== undefined) {
    throw new Error(
      `set exactly one of ${MASTER_KEY_ENV} or ${MASTER_KEY_FILE_ENV}, not both`,
    );
  }
  if (direct !== undefined) {
    return parseMasterKey(direct, MASTER_KEY_ENV);
  }
  if (file !== undefined) {
    return parseMasterKey(
      readFileSync(file, "utf8"),
      `${MASTER_KEY_FILE_ENV} (${file})`,
    );
  }
  throw new Error(
    `secrets require a master key: set ${MASTER_KEY_ENV} (base64) or ` +
      `${MASTER_KEY_FILE_ENV} (path to a file holding the base64 value)`,
  );
}
