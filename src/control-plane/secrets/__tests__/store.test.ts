import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSecretsStore } from "../store.ts";

// Contract tests for the SqliteSecretsStore (plan 0118, ADR 0016 §4). The
// threat shape they lock in: every sealed column is attacker-writable (the DB
// file is the asset being defended), so tampering, swaps, and truncated tags
// must all fail closed, and a wrong master key must fail with a diagnosis —
// not decrypt garbage.

const WRK = "wrk_default";

describe("SqliteSecretsStore", () => {
  let db: DatabaseSync;
  let master: Buffer;
  let store: SqliteSecretsStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    master = randomBytes(32);
    store = new SqliteSecretsStore(db, master);
  });

  afterEach(() => {
    store.close();
  });

  it("put/reveal round-trips the plaintext", () => {
    store.put(WRK, "github", "ghp_secret_token");
    expect(store.reveal(WRK, "github")).toBe("ghp_secret_token");
  });

  it("reveal of an unknown name returns undefined", () => {
    expect(store.reveal(WRK, "nope")).toBeUndefined();
  });

  it("upsert re-seals under a fresh DEK and keeps the row id", () => {
    const first = store.put(WRK, "github", "value-1");
    const ctBefore = readColumn(db, first.id, "ct");
    const second = store.put(WRK, "github", "value-1"); // same plaintext!
    const ctAfter = readColumn(db, second.id, "ct");
    expect(second.id).toBe(first.id);
    expect(second.created_at).toBe(first.created_at);
    // Same plaintext, different ciphertext: fresh DEK+IV per seal, so the DB
    // never reveals that two writes carried the same value.
    expect(Buffer.from(ctAfter).equals(Buffer.from(ctBefore))).toBe(false);
    expect(store.reveal(WRK, "github")).toBe("value-1");
  });

  // The sealed fields are attacker-writable DB columns; a flipped byte in any
  // of them must make reveal throw, never return attacker-chosen plaintext.
  it.each(["ct", "ct_tag", "ct_iv", "wrapped_dek", "wrap_tag", "wrap_iv"])(
    "reveal throws when the %s column is tampered",
    (column) => {
      const meta = store.put(WRK, "github", "ghp_secret_token");
      flipByte(db, meta.id, column);
      expect(() => store.reveal(WRK, "github")).toThrow();
    },
  );

  // node:crypto accepts short tags unless authTagLength is pinned (probe 45
  // (6b)) — forgery resistance would silently degrade from 2^128 to 2^32.
  // Both tag columns are attacker-writable, so both deciphers must pin.
  it.each(["ct_tag", "wrap_tag"])(
    "reveal rejects a truncated %s",
    (column) => {
      const meta = store.put(WRK, "github", "ghp_secret_token");
      truncateColumn(db, meta.id, column);
      expect(() => store.reveal(WRK, "github")).toThrow(/auth tag length/);
    },
  );

  it("reveal throws when the row is relabeled to another workspace/name (metadata AAD binding)", () => {
    // A DB-write attacker moves an existing row into another tenant's slot
    // without touching the ciphertext. The AAD binds workspace_id and name,
    // so the relabeled row must fail to open — not leak tenant A's secret
    // into tenant B's egress context.
    const meta = store.put("wrk_a", "github", "a-secret");
    db.prepare(
      "UPDATE secrets SET workspace_id = 'wrk_b', name = 'stolen' WHERE id = ?",
    ).run(meta.id);
    expect(() => store.reveal("wrk_b", "stolen")).toThrow();
  });

  it("reveal throws when ciphertext columns are copied onto another row (AAD swap defense)", () => {
    const a = store.put(WRK, "github", "secret-a");
    const b = store.put(WRK, "slack", "secret-b");
    // An attacker with DB write copies slack's whole sealed payload onto the
    // github row, hoping the app reveals secret-b where secret-a is expected.
    db.prepare(
      `UPDATE secrets SET
         version = src.version, kek_id = src.kek_id,
         wrap_iv = src.wrap_iv, wrap_tag = src.wrap_tag, wrapped_dek = src.wrapped_dek,
         ct_iv = src.ct_iv, ct_tag = src.ct_tag, ct = src.ct
       FROM (SELECT * FROM secrets WHERE id = ?) AS src
       WHERE secrets.id = ?`,
    ).run(b.id, a.id);
    expect(() => store.reveal(WRK, "github")).toThrow();
  });

  it("a store opened with the wrong master key fails with a kek diagnosis, not bare GCM garbage", () => {
    store.put(WRK, "github", "ghp_secret_token");
    const wrong = new SqliteSecretsStore(db, randomBytes(32));
    expect(() => wrong.reveal(WRK, "github")).toThrow(
      /sealed under a different master key/,
    );
  });

  it("scopes reveal/list/delete by workspace", () => {
    store.put("wrk_a", "github", "a-secret");
    expect(store.reveal("wrk_b", "github")).toBeUndefined();
    expect(store.list("wrk_b")).toEqual([]);
    expect(store.delete("wrk_b", "github")).toBe(false);
    expect(store.reveal("wrk_a", "github")).toBe("a-secret");
  });

  it("delete removes the secret and reports whether a row existed", () => {
    store.put(WRK, "github", "x");
    expect(store.delete(WRK, "github")).toBe(true);
    expect(store.reveal(WRK, "github")).toBeUndefined();
    expect(store.delete(WRK, "github")).toBe(false);
  });

  it("list returns metadata only — no sealed or plaintext fields", () => {
    store.put(WRK, "github", "ghp_secret_token");
    const [entry] = store.list(WRK);
    expect(Object.keys(entry!).sort()).toEqual([
      "created_at",
      "id",
      "name",
      "updated_at",
      "workspace_id",
    ]);
  });

  describe("rotateMasterKey", () => {
    it("rewraps every row, leaves ciphertext byte-identical, and switches keys", () => {
      const a = store.put(WRK, "github", "secret-a");
      const b = store.put("wrk_other", "slack", "secret-b");
      const ctBefore = Buffer.from(readColumn(db, a.id, "ct"));
      const oldKekId = store.currentKekId();

      const next = randomBytes(32);
      expect(store.rotateMasterKey(next)).toBe(2);

      // Ciphertext untouched (rotation must not re-encrypt — the envelope's
      // whole point); only the wrap changed.
      expect(Buffer.from(readColumn(db, a.id, "ct")).equals(ctBefore)).toBe(true);
      expect(store.currentKekId()).not.toBe(oldKekId);
      expect(store.reveal(WRK, "github")).toBe("secret-a");
      expect(store.reveal("wrk_other", "slack")).toBe("secret-b");

      // A store still holding the retired key can no longer open the rows.
      const stale = new SqliteSecretsStore(db, master);
      expect(() => stale.reveal(WRK, "github")).toThrow(
        /sealed under a different master key/,
      );
      // A fresh store opened with the new key can.
      const fresh = new SqliteSecretsStore(db, next);
      expect(fresh.reveal(WRK, "github")).toBe("secret-a");
      expect(b.id).toBeTruthy();
    });

    it("rolls back and keeps the old key when a row cannot be rewrapped", () => {
      store.put(WRK, "github", "secret-a");
      const b = store.put(WRK, "slack", "secret-b");
      // Corrupt the SECOND row's wrap: rotation rewraps github first, then
      // fails on slack — so without the transaction, github would be stranded
      // on the new key while the store keeps the old one.
      flipByte(db, b.id, "wrapped_dek");
      expect(() => store.rotateMasterKey(randomBytes(32))).toThrow();
      // The intact row must still open under the ORIGINAL key — a partial
      // rotation that left some rows on the new key would strand them.
      expect(store.reveal(WRK, "github")).toBe("secret-a");
    });

    it("rejects a truncated wrap_tag during rotation (rewrap path pins the tag length too)", () => {
      const meta = store.put(WRK, "github", "secret-a");
      truncateColumn(db, meta.id, "wrap_tag");
      expect(() => store.rotateMasterKey(randomBytes(32))).toThrow(
        /auth tag length/,
      );
    });
  });

  it("rejects an invalid master key at construction", () => {
    expect(() => new SqliteSecretsStore(db, randomBytes(16))).toThrow(
      /32 random bytes/,
    );
  });
});

function readColumn(db: DatabaseSync, id: string, column: string): Uint8Array {
  const row = db
    .prepare(`SELECT ${column} AS v FROM secrets WHERE id = ?`)
    .get(id) as { v: Uint8Array };
  return row.v;
}

function flipByte(db: DatabaseSync, id: string, column: string): void {
  const value = Buffer.from(readColumn(db, id, column));
  value[0] ^= 0x01;
  db.prepare(`UPDATE secrets SET ${column} = ? WHERE id = ?`).run(value, id);
}

function truncateColumn(db: DatabaseSync, id: string, column: string): void {
  const value = Buffer.from(readColumn(db, id, column)).subarray(0, 4);
  db.prepare(`UPDATE secrets SET ${column} = ? WHERE id = ?`).run(value, id);
}
