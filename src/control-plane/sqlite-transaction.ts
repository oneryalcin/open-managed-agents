import type { DatabaseSync } from "node:sqlite";

let nextSavepointId = 0;

export function withSqliteTransaction<T>(db: DatabaseSync, fn: () => T): T {
  const savepoint = `oma_tx_${nextSavepointId++}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = fn();
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}
