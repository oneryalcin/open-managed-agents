// Envelope-encryption primitives for the SecretsStore (ADR 0016 §4; shape
// validated by scratch/45-envelope-encryption-probe.ts, 11/11).
//
// Each secret is encrypted under a random per-secret DEK (AES-256-GCM); the
// DEK is wrapped by a KEK derived HKDF-SHA256(masterKey, info="oma-kek:<kekId>").
// Both layers bind an AAD (`<version>:<recordId>` on the ciphertext,
// `<version>:<kekId>:<recordId>` on the wrap) so a ciphertext copied onto
// another record fails to open. KEK rotation rewraps the DEK only — the
// ciphertext bytes are never touched.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";

export const ENVELOPE_FORMAT_VERSION = "v1";
export const MASTER_KEY_BYTES = 32;

// The persisted sealed form. In SQLite these are columns on the secret row;
// the plaintext DEK never persists.
export interface SealedSecret {
  version: string;
  kekId: string;
  wrapIv: Buffer;
  wrapTag: Buffer;
  wrappedDek: Buffer;
  ctIv: Buffer;
  ctTag: Buffer;
  ct: Buffer;
}

// kekId is a fingerprint of the master key (first 12 hex of SHA-256), not a
// counter: `open` can tell "sealed under a different master key" apart from
// corruption, and rotation selects rows to rewrap by the old fingerprint.
export function kekIdFor(masterKey: Buffer): string {
  assertMasterKey(masterKey);
  return createHash("sha256").update(masterKey).digest("hex").slice(0, 12);
}

export function assertMasterKey(masterKey: Buffer): void {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `master key must be exactly ${MASTER_KEY_BYTES} random bytes ` +
        "(HKDF is not a password KDF — see ADR 0016 §4)",
    );
  }
}

// KEK = HKDF-SHA256(masterKey, info=`oma-kek:<kekId>`): the raw master bytes
// are never used directly as a cipher key.
function deriveKek(masterKey: Buffer, kekId: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", masterKey, Buffer.alloc(0), `oma-kek:${kekId}`, 32),
  );
}

function gcmSeal(
  key: Buffer,
  plaintext: Buffer,
  aad: Buffer,
): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
}

function gcmOpen(
  key: Buffer,
  iv: Buffer,
  tag: Buffer,
  ct: Buffer,
  aad: Buffer,
): Buffer {
  // Pin authTagLength = 16 AND reject short tags explicitly. Without the pin
  // node:crypto ACCEPTS a truncated tag (probe 45 (6b): a 4-byte tag decrypts
  // with only a DEP0182 warning), degrading forgery resistance from 2^128 to
  // 2^32 — and the tag is an attacker-writable DB column.
  if (tag.length !== 16) {
    throw new Error(`bad auth tag length: ${tag.length} (expected 16)`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: 16,
  });
  decipher.setAuthTag(tag);
  decipher.setAAD(aad);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function seal(
  masterKey: Buffer,
  recordId: string,
  plaintext: Buffer,
): SealedSecret {
  const kekId = kekIdFor(masterKey);
  const kek = deriveKek(masterKey, kekId);
  const dek = randomBytes(32);
  try {
    const aad = Buffer.from(`${ENVELOPE_FORMAT_VERSION}:${recordId}`);
    const body = gcmSeal(dek, plaintext, aad);
    // The wrap layer binds the same record with the kekId added — defense in
    // depth, and the wrap is exactly the seam a KMS backend plugs into later.
    const wrapAad = Buffer.from(
      `${ENVELOPE_FORMAT_VERSION}:${kekId}:${recordId}`,
    );
    const wrapped = gcmSeal(kek, dek, wrapAad);
    return {
      version: ENVELOPE_FORMAT_VERSION,
      kekId,
      wrapIv: wrapped.iv,
      wrapTag: wrapped.tag,
      wrappedDek: wrapped.ct,
      ctIv: body.iv,
      ctTag: body.tag,
      ct: body.ct,
    };
  } finally {
    dek.fill(0); // best-effort scrub; Node makes no hard guarantee
    kek.fill(0);
  }
}

export function open(
  masterKey: Buffer,
  recordId: string,
  sealed: SealedSecret,
): Buffer {
  const currentKekId = kekIdFor(masterKey);
  if (sealed.kekId !== currentKekId) {
    throw new Error(
      `secret is sealed under a different master key (kekId ${sealed.kekId}, ` +
        `current key is ${currentKekId}) — rotate or supply the original key`,
    );
  }
  const kek = deriveKek(masterKey, sealed.kekId);
  let dek: Buffer | undefined;
  try {
    const wrapAad = Buffer.from(
      `${sealed.version}:${sealed.kekId}:${recordId}`,
    );
    dek = gcmOpen(kek, sealed.wrapIv, sealed.wrapTag, sealed.wrappedDek, wrapAad);
    const aad = Buffer.from(`${sealed.version}:${recordId}`);
    return gcmOpen(dek, sealed.ctIv, sealed.ctTag, sealed.ct, aad);
  } finally {
    dek?.fill(0);
    kek.fill(0);
  }
}

// Rotation: unwrap the DEK with the old master key, rewrap with the new one.
// ct / ctIv / ctTag are deliberately untouched — the point of the envelope.
// Note (ADR 0016 §4): this limits blast radius going forward; it does not
// revoke a key that leaked alongside a pre-rotation DB copy.
export function rewrap(
  oldMasterKey: Buffer,
  newMasterKey: Buffer,
  recordId: string,
  sealed: SealedSecret,
): SealedSecret {
  const oldKekId = kekIdFor(oldMasterKey);
  if (sealed.kekId !== oldKekId) {
    throw new Error(
      `cannot rewrap: secret is sealed under kekId ${sealed.kekId}, ` +
        `but the supplied old key is ${oldKekId}`,
    );
  }
  const newKekId = kekIdFor(newMasterKey);
  const oldKek = deriveKek(oldMasterKey, sealed.kekId);
  const newKek = deriveKek(newMasterKey, newKekId);
  let dek: Buffer | undefined;
  try {
    const oldWrapAad = Buffer.from(
      `${sealed.version}:${sealed.kekId}:${recordId}`,
    );
    dek = gcmOpen(
      oldKek,
      sealed.wrapIv,
      sealed.wrapTag,
      sealed.wrappedDek,
      oldWrapAad,
    );
    const newWrapAad = Buffer.from(
      `${sealed.version}:${newKekId}:${recordId}`,
    );
    const rewrapped = gcmSeal(newKek, dek, newWrapAad);
    return {
      ...sealed,
      kekId: newKekId,
      wrapIv: rewrapped.iv,
      wrapTag: rewrapped.tag,
      wrappedDek: rewrapped.ct,
      // ct / ctIv / ctTag deliberately unchanged
    };
  } finally {
    dek?.fill(0);
    oldKek.fill(0);
    newKek.fill(0);
  }
}
