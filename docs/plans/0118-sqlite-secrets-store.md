# 0118 SqliteSecretsStore

Date: 2026-07-03

Implements: [ADR 0016 §4](../adrs/0016-egress-proxy-and-secret-injection.md)
(envelope-encrypted secrets in OMA's SQLite, no vault dependency).
Roadmap: capability track of the [0114 roadmap](0114-appliance-product-roadmap.md).
Crypto shape validated by probe 45 (`scratch/45-envelope-encryption-probe.ts`,
11/11). Unblocks 0117c credential injection, which resolves credential grants
against this store.

## Scope

The store itself: crypto module, master-key loading contract, SQLite
persistence behind a `SecretsStore` interface, tests. **Non-goals** (later
slices): HTTP API surface for managing secrets (lands with or after 0117c),
OAuth token refresh, KMS/OpenBao-backed store implementations, scrypt
passphrase support, wiring `OMA_MASTER_KEY` into appliance boot (nothing
consumes secrets until 0117c — don't add a required env var before it does
anything).

## Layout

```
src/control-plane/secrets/
  types.ts       SecretsStore interface + SecretMetadata
  envelope.ts    pure crypto: seal / open / rewrap / deriveKek / kekIdFor
  master-key.ts  loadMasterKey(env) + generateMasterKey()
  store.ts       SqliteSecretsStore
  __tests__/
```

## Decisions

- **Interface** (deliberately small; grows only when 0117c pulls on it):

  ```ts
  interface SecretsStore {
    put(workspaceId, name, value): SecretMetadata;    // upsert; always a fresh DEK
    reveal(workspaceId, name): string | undefined;    // plaintext — egress boundary only
    list(workspaceId): SecretMetadata[];              // metadata only, never values
    delete(workspaceId, name): boolean;
    rotateMasterKey(newMaster: Buffer): number;       // rewrap every row; returns count
    close(): void;
  }
  ```

  The plaintext-returning call is named **`reveal`**, not `get`, so every call
  site is loud and greppable. `list`/metadata never carry plaintext.

- **Schema**: one `secrets` table; the eight sealed fields from ADR 0016 §4 as
  columns, binary ones as BLOBs (probed: `node:sqlite` round-trips Buffers as
  `Uint8Array`; `Buffer.from()` on read). `UNIQUE (workspace_id, name)`;
  immutable `id` (`sec_<uuidv7>`) is the primary key.

- **AAD record binding = `JSON.stringify([id, workspace_id, name])`** — the
  immutable row id AND the addressing metadata. The id alone (first draft)
  stops ciphertext copied onto another row but NOT a relabel of the same row
  (`UPDATE secrets SET workspace_id = 'wrk_b', name = 'stolen'`), which would
  leak tenant A's secret into tenant B's slot without touching ciphertext —
  review finding, accepted. JSON encoding keeps the components unambiguous;
  there is no rename API, so the binding never needs to move. Upsert of an
  existing name keeps the id (binding unchanged) and re-seals under a fresh
  DEK.

- **`kekId` = first 12 hex chars of SHA-256(masterKey)** — a fingerprint, not
  a counter. Self-describing rotation: `reveal` checks the row's `kek_id`
  against the current key's fingerprint first and throws a *descriptive* error
  ("sealed under a different master key") instead of a bare GCM failure;
  `rotateMasterKey` selects rows to rewrap by the old fingerprint.

- **Hardening, mandatory per ADR 0016 §4** (both probe-verified):
  `authTagLength: 16` pinned on every decipher + explicit tag-length guard
  (node otherwise accepts truncated tags — the tag is an attacker-writable DB
  column); master key is exactly 32 random bytes, base64-encoded, anything
  else refused (HKDF is not a password KDF).

- **Master key loading**: `OMA_MASTER_KEY` (base64) or `OMA_MASTER_KEY_FILE`
  (path to a file holding the base64 — the docker-compose secrets idiom).
  Exactly one must be set when loading is requested. `generateMasterKey()`
  returns fresh base64 for docs/first-run instructions.

- **Rotation** rewraps the DEK only (ciphertext untouched, probe 45 (7));
  runs inside a transaction; store swaps to the new key in memory afterwards.
  ADR honesty note applies: rotation limits blast radius, it is not
  revocation.

- **Best-effort DEK zeroing** (`dek.fill(0)`) after each seal/open/rewrap.
  Node gives no hard guarantee; cheap and directionally right.

- **Persisted key epoch** (`secrets_config.current_kek_id`; Codex adversarial
  finding, confirmed by repro). Rotation alone is instance-local: a second
  store over the same DB — a provisioning CLI, or the live server before its
  restart — would keep sealing under the retired key, creating rows the
  rotated store can never read. So the DB records the active key fingerprint:
  the first store to open an empty DB claims it, any later constructor must
  present the same key (fail fast, not GCM garbage), `put()` re-checks inside
  its write transaction, and rotation flips the epoch atomically with the
  rewraps. The envelope's row-level kekId check stays as defense in depth
  (e.g. a backup restored from before a rotation).

- **Considered and declined: FK `workspace_id REFERENCES workspaces`**
  (review finding). Precedent exists (`workspace_api_keys` FKs within the
  workspace store's own schema), but every cross-module workspace-scoped
  store (environments, agents, sessions) deliberately carries no FK — a
  cross-module FK adds schema-ordering coupling (inserts fail in any DB where
  the workspaces schema hasn't run first, including standalone tests). A
  separate `(workspace_id, name)` index is redundant: `UNIQUE` already
  creates it. Nonexistent-workspace validation belongs to the service/API
  layer landing with 0117c, like every other resource. Revisit at 0117c
  wiring.

## Tests (what production bug does each prevent?)

- put/reveal round-trip; upsert re-seals (new ct, same id) — store corrupts a
  secret.
- Tampered `ct` / `ct_tag` / `wrapped_dek` column → reveal throws — attacker
  with DB write forges or swaps a secret.
- Truncated `ct_tag` AND `wrap_tag` rejected, on both the reveal and rotation
  paths — forgery resistance silently degraded to 2^32 on either decipher.
- Ciphertext columns copied onto another row → reveal throws — cross-record
  swap attack.
- Row relabeled to another workspace/name → reveal throws — cross-tenant
  disclosure via metadata rewrite.
- Wrong master key → fail-fast at construction with a kek diagnosis, not bare
  GCM throw — operator misdiagnoses a key mixup as corruption.
- Stale store `put()` after another store rotates → rejected, no unreadable
  row — retired-key writes strand secrets (Codex adversarial finding).
- Workspace isolation: reveal/list/delete scoped by workspace — tenant reads
  another tenant's secret.
- `rotateMasterKey`: new key opens, old fingerprint gone, `ct` byte-identical
  — rotation silently re-encrypts (perf trap) or breaks records.
- `loadMasterKey`: rejects missing/short/long/non-base64 keys, both-set and
  neither-set env; accepts the file variant — weak or misparsed master key.
- `list` output contains no plaintext field — metadata path leaks values.
