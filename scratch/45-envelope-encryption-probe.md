# Probe 45 — envelope-encryption round-trip for SecretsStore

Date: 2026-07-02
Script: `scratch/45-envelope-encryption-probe.ts`
Context: 0114 capability track; the survey's "next step 2"
([egress-secrets-buy-vs-build.md](../docs/references/egress-secrets-buy-vs-build.md))
— prove the secrets design in `node:crypto` alone before the ADR pins the
`SecretsStore` schema.

## Question

Can `node:crypto` (zero new deps) back the survey's chosen design —
AES-256-GCM per-secret DEK, wrapped by a master KEK from env/file — with the
properties the ADR will rely on?

## Result: 10/10, deterministic

| Check | Result |
|---|---|
| (1) round-trip seal/open returns the original | PASS |
| (2) same plaintext → different ciphertext (fresh DEK+IV) | PASS |
| (3) ciphertext tamper detected (GCM auth) | PASS |
| (4) wrapped-DEK tamper detected | PASS |
| (5) ciphertext cannot be opened under a different record id (AAD) | PASS |
| (6) the wrong master key cannot open | PASS |
| (7a) rotation leaves ciphertext byte-for-byte identical | PASS |
| (7b) the new master key opens the rotated record | PASS |
| (7c) the old master key no longer opens the rotated record | PASS |
| (8) a version tag is present for migration | PASS |

Rigor check: dropping the AAD from both seal and open (a mutation) keeps (1)
passing but flips (5) to FAIL — so (5) genuinely exercises record binding, it
is not passing vacuously.

## The shape the ADR can adopt

- **Two layers.** Each secret is encrypted under its own random 32-byte DEK
  (AES-256-GCM, random 12-byte IV, 16-byte tag). The DEK is then wrapped by a
  KEK, also AES-256-GCM. Only the wrapped DEK persists; the plaintext DEK
  never touches disk.
- **KEK derivation.** `KEK = HKDF-SHA256(masterSecret, info="oma-kek:<kekId>")`.
  The master secret is the 32+ bytes from `OMA_MASTER_KEY` / a key file;
  HKDF means the raw master bytes are never a cipher key directly, and each
  `kekId` yields a distinct wrapping key.
- **Record binding via AAD.** The ciphertext's AAD is `<version>:<recordId>`
  (e.g. `v1:wrk_default/github`), so a ciphertext blob cannot be lifted from
  one row and opened as another — cross-record swap fails to authenticate.
- **Rotation is the KMS seam.** `rewrap(oldMaster, newMaster, newKekId,
  sealed)` unwraps the DEK with the old KEK and rewraps with the new one; the
  ciphertext is untouched (proved byte-for-byte in 7a). This is exactly where
  an external KMS / OpenBao-transit backend replaces the local KEK-wrap step
  for SaaS — one function, not a framework (the modularity stance in the
  survey and 0114).
- **Version tag** (`v1:`) on every record for forward migration.

## Persisted record fields (for the SqliteSecretsStore schema)

`version, kekId, wrapIv, wrapTag, wrappedDek, ctIv, ctTag, ct` — `kekId` lets
rotation find the rows a given master key wrapped. In SQLite these are columns
(or one blob) on the secret row.

## Verdict

Green light. Both survey foundations are now probed (egress proxy in probe 44,
secrets envelope here). The ADR can proceed: egress policy contract +
`SecretsStore` with this envelope shape, closing #130.
