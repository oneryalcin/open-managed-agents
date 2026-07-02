/**
 * Probe 45: envelope-encryption round-trip for the SecretsStore (0114
 * capability track; the survey's "next step 2" before the ADR pins a schema).
 *
 * Question: can `node:crypto` alone (zero new deps) back the survey's chosen
 * secrets design — AES-256-GCM per-secret DEK, wrapped by a master KEK from
 * env/file — with the properties the ADR will rely on?
 *
 *   (1) round-trip: seal then open returns the original;
 *   (2) fresh DEK + IV per seal: same plaintext -> different ciphertext (no
 *       deterministic-encryption leak);
 *   (3) ciphertext tamper is detected (GCM auth);
 *   (4) wrapped-DEK tamper is detected;
 *   (5) AAD binds the record: a ciphertext moved to another record id fails
 *       to open (no cross-record swap);
 *   (6) the wrong master key cannot open;
 *   (7) KEK ROTATION rewraps the DEK only — ciphertext bytes are byte-for-byte
 *       identical, the new KEK opens, the old KEK no longer does. This is the
 *       seam an external KMS/OpenBao-transit backend plugs into later.
 *   (8) a version tag is present for future format migration.
 *
 * Run: npx tsx scratch/45-envelope-encryption-probe.ts   (no external deps)
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const results: Array<{ check: string; pass: boolean; detail: string }> = [];
function record(check: string, pass: boolean, detail: string) {
  results.push({ check, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${check} — ${detail}`);
}

const FORMAT_VERSION = "v1";

// A stored secret. In SQLite these are columns/a blob on the row; the DEK is
// wrapped, so the plaintext DEK never persists. `kekId` records which master
// key wrapped this DEK, so rotation can find rows to rewrap.
interface SealedSecret {
  version: string;
  kekId: string;
  wrapIv: Buffer;
  wrapTag: Buffer;
  wrappedDek: Buffer;
  ctIv: Buffer;
  ctTag: Buffer;
  ct: Buffer;
}

// KEK = HKDF-SHA256(masterSecret, info=`oma-kek:<kekId>`). Master secret is
// the 32+ bytes from OMA_MASTER_KEY / key file; deriving via HKDF means the
// raw master bytes are never used directly as a cipher key and each kekId
// yields a distinct wrapping key.
function deriveKek(masterSecret: Buffer, kekId: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", masterSecret, Buffer.alloc(0), `oma-kek:${kekId}`, 32),
  );
}

function gcmSeal(key: Buffer, plaintext: Buffer, aad?: Buffer): {
  iv: Buffer;
  tag: Buffer;
  ct: Buffer;
} {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
}

function gcmOpen(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer, aad?: Buffer): Buffer {
  // Pin authTagLength = 16 AND reject short tags explicitly. Without the pin,
  // node:crypto ACCEPTS a truncated tag (verified: a 4-byte tag decrypts with
  // only a DEP0182 warning), degrading forgery resistance from 2^128 to 2^32.
  // In the real SecretsStore the tag is an attacker-writable DB column, so this
  // is the production-shape requirement, not a nicety.
  if (tag.length !== 16) throw new Error(`bad auth tag length: ${tag.length}`);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(aad);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function seal(
  masterSecret: Buffer,
  kekId: string,
  recordId: string,
  plaintext: string,
): SealedSecret {
  const kek = deriveKek(masterSecret, kekId);
  const dek = randomBytes(32);
  const aad = Buffer.from(`${FORMAT_VERSION}:${recordId}`);
  const body = gcmSeal(dek, Buffer.from(plaintext, "utf8"), aad);
  // Bind the wrap layer with the same AAD (defense in depth, and because the
  // wrap is exactly the seam that later becomes a KMS call).
  const wrapAad = Buffer.from(`${FORMAT_VERSION}:${kekId}:${recordId}`);
  const wrapped = gcmSeal(kek, dek, wrapAad); // DEK wrapped by KEK
  return {
    version: FORMAT_VERSION,
    kekId,
    wrapIv: wrapped.iv,
    wrapTag: wrapped.tag,
    wrappedDek: wrapped.ct,
    ctIv: body.iv,
    ctTag: body.tag,
    ct: body.ct,
  };
}

function open(masterSecret: Buffer, recordId: string, s: SealedSecret): string {
  const kek = deriveKek(masterSecret, s.kekId);
  const wrapAad = Buffer.from(`${s.version}:${s.kekId}:${recordId}`);
  const dek = gcmOpen(kek, s.wrapIv, s.wrapTag, s.wrappedDek, wrapAad);
  const aad = Buffer.from(`${s.version}:${recordId}`);
  return gcmOpen(dek, s.ctIv, s.ctTag, s.ct, aad).toString("utf8");
}

// Rotation: unwrap the DEK with the old master key, rewrap with the new one.
// The ciphertext (ct/ctIv/ctTag) is never touched — the whole point of the
// envelope. Returns a new SealedSecret tagged with the new kekId.
function rewrap(
  oldMaster: Buffer,
  newMaster: Buffer,
  newKekId: string,
  recordId: string,
  s: SealedSecret,
): SealedSecret {
  const oldWrapAad = Buffer.from(`${s.version}:${s.kekId}:${recordId}`);
  const oldKek = deriveKek(oldMaster, s.kekId);
  const dek = gcmOpen(oldKek, s.wrapIv, s.wrapTag, s.wrappedDek, oldWrapAad);
  const newKek = deriveKek(newMaster, newKekId);
  const newWrapAad = Buffer.from(`${s.version}:${newKekId}:${recordId}`);
  const rewrapped = gcmSeal(newKek, dek, newWrapAad);
  return {
    ...s,
    kekId: newKekId,
    wrapIv: rewrapped.iv,
    wrapTag: rewrapped.tag,
    wrappedDek: rewrapped.ct,
    // ct / ctIv / ctTag deliberately unchanged
  };
}

// ---------------------------------------------------------------------------
const master = randomBytes(32);
const SECRET = "ghp_realGitHubToken_do_not_leak_9f3a";
const RECORD = "wrk_default/github";

const sealed = seal(master, "kek-1", RECORD, SECRET);

// (1) round-trip
record(
  "(1) round-trip seal/open returns the original",
  open(master, RECORD, sealed) === SECRET,
  "opened plaintext matches",
);

// (2) fresh DEK + IV per seal
const sealedAgain = seal(master, "kek-1", RECORD, SECRET);
record(
  "(2) same plaintext -> different ciphertext (fresh DEK+IV)",
  !sealed.ct.equals(sealedAgain.ct) && !sealed.wrappedDek.equals(sealedAgain.wrappedDek),
  "ciphertext and wrapped DEK both differ across two seals",
);

// (3) ciphertext tamper detected
const tamperedCt: SealedSecret = { ...sealed, ct: Buffer.from(sealed.ct) };
tamperedCt.ct[0] ^= 0x01;
record(
  "(3) ciphertext tamper is detected",
  throws(() => open(master, RECORD, tamperedCt)),
  "flipping one ciphertext byte makes open throw",
);

// (4) wrapped-DEK tamper detected
const tamperedDek: SealedSecret = { ...sealed, wrappedDek: Buffer.from(sealed.wrappedDek) };
tamperedDek.wrappedDek[0] ^= 0x01;
record(
  "(4) wrapped-DEK tamper is detected",
  throws(() => open(master, RECORD, tamperedDek)),
  "flipping one wrapped-DEK byte makes open throw",
);

// (5) AAD binds the record id
record(
  "(5) ciphertext cannot be opened under a different record id",
  throws(() => open(master, "wrk_default/other", sealed)),
  "opening the same bytes with a different recordId throws (AAD mismatch)",
);

// (6) wrong master key cannot open
record(
  "(6) the wrong master key cannot open",
  throws(() => open(randomBytes(32), RECORD, sealed)),
  "a different master secret makes DEK unwrap throw",
);

// (6b) truncated auth tag rejected (node accepts short tags without the
// authTagLength pin — verified separately). Guards the SecretsStore shape
// where the tag is an attacker-writable column.
const truncTag: SealedSecret = { ...sealed, ctTag: sealed.ctTag.subarray(0, 4) };
record(
  "(6b) a truncated auth tag is rejected",
  throws(() => open(master, RECORD, truncTag)),
  "opening with a 4-byte tag throws (authTagLength=16 pinned + length guard)",
);

// (7) KEK rotation rewraps the DEK only
const newMaster = randomBytes(32);
const rotated = rewrap(master, newMaster, "kek-2", RECORD, sealed);
record(
  "(7a) rotation leaves the ciphertext byte-for-byte identical",
  rotated.ct.equals(sealed.ct) &&
    rotated.ctIv.equals(sealed.ctIv) &&
    rotated.ctTag.equals(sealed.ctTag),
  "ct / ctIv / ctTag unchanged; only the wrapped DEK changed",
);
record(
  "(7b) the new master key opens the rotated record",
  open(newMaster, RECORD, rotated) === SECRET,
  "post-rotation open with the new master returns the original",
);
record(
  "(7c) the old master key no longer opens the rotated record",
  throws(() => open(master, RECORD, rotated)),
  "the retired master can no longer unwrap the rewrapped DEK",
);

// (8) version tag present
record(
  "(8) a version tag is present for migration",
  sealed.version === "v1",
  `version = ${sealed.version}`,
);

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
