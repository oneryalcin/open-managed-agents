import { DatabaseSync, type StatementSync } from "node:sqlite";
import { withSqliteTransaction } from "../sqlite-transaction.ts";
import { newSecretId } from "../ids.ts";
import {
  assertMasterKey,
  kekIdFor,
  open,
  rewrap,
  seal,
  type SealedSecret,
} from "./envelope.ts";
import type { SecretMetadata, SecretsStore } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS secrets_config (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  current_kek_id  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS secrets (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  name          TEXT NOT NULL,
  version       TEXT NOT NULL,
  kek_id        TEXT NOT NULL,
  wrap_iv       BLOB NOT NULL,
  wrap_tag      BLOB NOT NULL,
  wrapped_dek   BLOB NOT NULL,
  ct_iv         BLOB NOT NULL,
  ct_tag        BLOB NOT NULL,
  ct            BLOB NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);
`;

interface SecretDbRow {
  id: string;
  workspace_id: string;
  name: string;
  version: string;
  kek_id: string;
  wrap_iv: Uint8Array;
  wrap_tag: Uint8Array;
  wrapped_dek: Uint8Array;
  ct_iv: Uint8Array;
  ct_tag: Uint8Array;
  ct: Uint8Array;
  created_at: string;
  updated_at: string;
}

export class SqliteSecretsStore implements SecretsStore {
  private readonly db: DatabaseSync;
  private masterKey: Buffer;
  private kekId: string;
  private readonly configGetStmt: StatementSync;
  private readonly configSetStmt: StatementSync;
  private readonly insertStmt: StatementSync;
  private readonly resealStmt: StatementSync;
  private readonly selectStmt: StatementSync;
  private readonly listStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly selectAllStmt: StatementSync;
  private readonly rewrapStmt: StatementSync;

  constructor(db: DatabaseSync, masterKey: Buffer) {
    assertMasterKey(masterKey);
    this.db = db;
    // Copy: the caller's buffer must not be able to mutate the store's key,
    // and rotateMasterKey scrubs the old one.
    this.masterKey = Buffer.from(masterKey);
    this.kekId = kekIdFor(this.masterKey);
    this.db.exec(SCHEMA);
    this.configGetStmt = this.db.prepare(
      `SELECT current_kek_id FROM secrets_config WHERE id = 1`,
    );
    this.configSetStmt = this.db.prepare(
      `INSERT INTO secrets_config (id, current_kek_id) VALUES (1, ?)
       ON CONFLICT (id) DO UPDATE SET current_kek_id = excluded.current_kek_id`,
    );
    // Claim or validate the database-wide key epoch (adversarial-review
    // finding): the first store to open an empty DB records its key
    // fingerprint; any later store must present the SAME key, so a process
    // holding a retired key fails fast here instead of writing rows nobody
    // can read.
    withSqliteTransaction(this.db, () => {
      const current = this.currentConfigKekId();
      if (current === undefined) {
        this.configSetStmt.run(this.kekId);
      } else if (current !== this.kekId) {
        throw new Error(
          `secrets database is keyed to a different master key (current ` +
            `kekId ${current}, supplied key is ${this.kekId}) — supply the ` +
            `active key, or rotate from it`,
        );
      }
    });
    this.insertStmt = this.db.prepare(
      `INSERT INTO secrets (
        id, workspace_id, name, version, kek_id,
        wrap_iv, wrap_tag, wrapped_dek, ct_iv, ct_tag, ct,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.resealStmt = this.db.prepare(
      `UPDATE secrets SET
        version = ?, kek_id = ?,
        wrap_iv = ?, wrap_tag = ?, wrapped_dek = ?, ct_iv = ?, ct_tag = ?, ct = ?,
        updated_at = ?
      WHERE id = ?`,
    );
    this.selectStmt = this.db.prepare(
      `SELECT * FROM secrets WHERE workspace_id = ? AND name = ?`,
    );
    this.listStmt = this.db.prepare(
      `SELECT id, workspace_id, name, created_at, updated_at FROM secrets
       WHERE workspace_id = ? ORDER BY name ASC`,
    );
    this.deleteStmt = this.db.prepare(
      `DELETE FROM secrets WHERE workspace_id = ? AND name = ?`,
    );
    this.selectAllStmt = this.db.prepare(`SELECT * FROM secrets`);
    this.rewrapStmt = this.db.prepare(
      `UPDATE secrets SET kek_id = ?, wrap_iv = ?, wrap_tag = ?, wrapped_dek = ?
       WHERE id = ?`,
    );
  }

  static open(path: string, masterKey: Buffer): SqliteSecretsStore {
    return new SqliteSecretsStore(new DatabaseSync(path), masterKey);
  }

  put(workspaceId: string, name: string, value: string): SecretMetadata {
    if (workspaceId === "" || name === "") {
      throw new Error("workspaceId and name must be non-empty");
    }
    const now = new Date().toISOString();
    // The write transaction re-checks the key epoch: a store constructed
    // before a rotation must not seal new rows under the retired key — the
    // rotated store could never read them (adversarial-review finding).
    return withSqliteTransaction(this.db, () => {
      this.assertActiveKey();
      const existing = this.selectStmt.get(workspaceId, name) as
        | unknown as SecretDbRow
        | undefined;
      // An upsert keeps the row id and re-seals under a fresh DEK.
      const id = existing?.id ?? newSecretId();
      const sealed = seal(
        this.masterKey,
        recordBinding(id, workspaceId, name),
        Buffer.from(value, "utf8"),
      );
      if (existing) {
        this.resealStmt.run(
          sealed.version,
          sealed.kekId,
          sealed.wrapIv,
          sealed.wrapTag,
          sealed.wrappedDek,
          sealed.ctIv,
          sealed.ctTag,
          sealed.ct,
          now,
          id,
        );
        return {
          id,
          workspace_id: workspaceId,
          name,
          created_at: existing.created_at,
          updated_at: now,
        };
      }
      this.insertStmt.run(
        id,
        workspaceId,
        name,
        sealed.version,
        sealed.kekId,
        sealed.wrapIv,
        sealed.wrapTag,
        sealed.wrappedDek,
        sealed.ctIv,
        sealed.ctTag,
        sealed.ct,
        now,
        now,
      );
      return {
        id,
        workspace_id: workspaceId,
        name,
        created_at: now,
        updated_at: now,
      };
    });
  }

  reveal(workspaceId: string, name: string): string | undefined {
    const row = this.selectStmt.get(workspaceId, name) as
      | unknown as SecretDbRow
      | undefined;
    if (!row) return undefined;
    const plaintext = open(
      this.masterKey,
      recordBinding(row.id, workspaceId, name),
      sealedFromRow(row),
    );
    const value = plaintext.toString("utf8");
    plaintext.fill(0);
    return value;
  }

  list(workspaceId: string): SecretMetadata[] {
    const rows = this.listStmt.all(workspaceId) as unknown as Array<
      Pick<SecretDbRow, "id" | "workspace_id" | "name" | "created_at" | "updated_at">
    >;
    return rows.map((row) => ({
      id: row.id,
      workspace_id: row.workspace_id,
      name: row.name,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  delete(workspaceId: string, name: string): boolean {
    return this.deleteStmt.run(workspaceId, name).changes > 0;
  }

  rotateMasterKey(newMasterKey: Buffer): number {
    assertMasterKey(newMasterKey);
    const oldKey = this.masterKey;
    const next = Buffer.from(newMasterKey);
    const nextKekId = kekIdFor(next);
    const count = withSqliteTransaction(this.db, () => {
      // Only the store holding the ACTIVE key may rotate; the epoch flips in
      // the same transaction as the rewraps, so writers serialize against it.
      this.assertActiveKey();
      const rows = this.selectAllStmt.all() as unknown as SecretDbRow[];
      for (const row of rows) {
        const rotated = rewrap(
          oldKey,
          next,
          recordBinding(row.id, row.workspace_id, row.name),
          sealedFromRow(row),
        );
        this.rewrapStmt.run(
          rotated.kekId,
          rotated.wrapIv,
          rotated.wrapTag,
          rotated.wrappedDek,
          row.id,
        );
      }
      this.configSetStmt.run(nextKekId);
      return rows.length;
    });
    this.masterKey = next;
    this.kekId = nextKekId;
    oldKey.fill(0);
    return count;
  }

  private currentConfigKekId(): string | undefined {
    const row = this.configGetStmt.get() as
      | { current_kek_id: string }
      | undefined;
    return row?.current_kek_id;
  }

  private assertActiveKey(): void {
    const current = this.currentConfigKekId();
    if (current !== this.kekId) {
      throw new Error(
        `this store holds a retired master key (kekId ${this.kekId}, the ` +
          `database is keyed to ${current}) — reopen with the active key`,
      );
    }
  }

  /** Fingerprint of the store's current master key (for diagnostics/tests). */
  currentKekId(): string {
    return kekIdFor(this.masterKey);
  }

  // Zero the in-process master key without closing the db — for durable
  // deployments where the db is shared and closed once elsewhere, so close()
  // is skipped but the key must still be scrubbed on shutdown.
  scrubMasterKey(): void {
    this.masterKey.fill(0);
  }

  close(): void {
    this.scrubMasterKey();
    this.db.close();
  }
}

// The AAD record binding covers the immutable row id AND the addressing
// metadata (workspace_id, name): a DB-write attacker can neither copy a
// ciphertext onto another row (id differs) nor relabel a row into another
// workspace/name slot (metadata differs) — either way `open` fails. JSON
// encoding keeps the three components unambiguous regardless of their
// contents. There is no rename API, so the binding never needs to move.
function recordBinding(id: string, workspaceId: string, name: string): string {
  return JSON.stringify([id, workspaceId, name]);
}

function sealedFromRow(row: SecretDbRow): SealedSecret {
  return {
    version: row.version,
    kekId: row.kek_id,
    wrapIv: Buffer.from(row.wrap_iv),
    wrapTag: Buffer.from(row.wrap_tag),
    wrappedDek: Buffer.from(row.wrapped_dek),
    ctIv: Buffer.from(row.ct_iv),
    ctTag: Buffer.from(row.ct_tag),
    ct: Buffer.from(row.ct),
  };
}
