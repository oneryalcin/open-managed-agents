import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkspacesCli } from "../../../scripts/oma-workspaces.ts";
import {
  createDeploymentStoresFromEnv,
  openWorkspaceStoreForProvisioning,
} from "../deployment-storage.ts";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// A database the durable server actually initialized once — provisioning
// refuses anything else.
function makeDb(): string {
  const root = mkdtempSync(join(tmpdir(), "oma-cli-"));
  tempRoots.push(root);
  const path = join(root, "oma.db");
  createDeploymentStoresFromEnv({
    OMA_SQLITE_PATH: path,
    OMA_FILE_STORAGE_ROOT: join(root, "objects"),
  }).close();
  return path;
}

function cli(dbPath: string, ...args: string[]) {
  return runWorkspacesCli(args, { OMA_SQLITE_PATH: dbPath });
}

describe("oma-workspaces CLI", () => {
  it("creates a workspace and mints a key that authenticates", () => {
    const db = makeDb();
    const created = cli(db, "create-workspace", "Acme");
    expect(created.code).toBe(0);
    const workspaceId = created.stdout.match(/Created workspace (wrk_\S+)/)?.[1];
    expect(workspaceId).toBeDefined();

    const minted = cli(db, "mint-key", workspaceId!, "ci");
    expect(minted.code).toBe(0);
    expect(minted.stdout).toContain("ONLY time the key is shown");
    const plaintext = minted.stdout.match(/API key: {4}(oma_\S+)/)?.[1];
    expect(plaintext).toBeDefined();

    const store = openWorkspaceStoreForProvisioning(db);
    expect(store.authenticate(plaintext!)).toBe(workspaceId);
    store.close();
  });

  it("revokes a key and reports an already-revoked key without changing it", () => {
    const db = makeDb();
    const minted = cli(db, "mint-key", "wrk_default");
    const hash = minted.stdout.match(/Key sha256: ([0-9a-f]{64})/)?.[1];
    expect(hash).toBeDefined();

    const revoked = cli(db, "revoke-key", hash!);
    expect(revoked.code).toBe(0);
    expect(revoked.stdout).toContain(`Revoked ${hash}`);

    const again = cli(db, "revoke-key", hash!);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/already revoked at \S+/);

    const listed = cli(db, "list-keys", "wrk_default");
    expect(listed.stdout).toContain("revoked");
    expect(listed.stdout).not.toContain("active");
  });

  it("lists workspaces including the seeded default", () => {
    const db = makeDb();
    cli(db, "create-workspace", "Beta");
    const listed = cli(db, "list-workspaces");
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("wrk_default\tDefault workspace");
    expect(listed.stdout).toContain("Beta");
  });

  it("fails with exit 1 and a clear message on operator errors", () => {
    const db = makeDb();
    expect(cli(db, "mint-key", "wrk_ghost")).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Workspace not found: wrk_ghost"),
    });
    expect(cli(db, "revoke-key", "deadbeef")).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Key not found"),
    });
    expect(cli(db, "definitely-not-a-command")).toMatchObject({ code: 1 });
    expect(cli(db, "create-workspace")).toMatchObject({ code: 1 });
    expect(runWorkspacesCli(["list-workspaces"], {})).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("OMA_SQLITE_PATH"),
    });
    expect(
      runWorkspacesCli(["list-workspaces"], {
        OMA_SQLITE_PATH: join(tmpdir(), "does-not-exist", "x.db"),
      }),
    ).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("existing OMA database"),
    });
  });

  it("refuses to touch an existing SQLite file the server never initialized", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-cli-"));
    tempRoots.push(root);
    const strangerDb = join(root, "someone-elses.db");
    const db = new DatabaseSync(strangerDb);
    db.exec("CREATE TABLE invoices (id TEXT PRIMARY KEY)");
    db.close();

    const result = cli(strangerDb, "mint-key", "wrk_default");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not an initialized OMA durable database");
    // The stranger's database was not modified: no OMA tables appeared.
    const check = new DatabaseSync(strangerDb);
    const tables = check
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as { name: string }[];
    check.close();
    expect(tables.map((t) => t.name)).toEqual(["invoices"]);
  });

  it("runs as a real subprocess with env, argv, and exit-code wiring", () => {
    const db = makeDb();
    // Direct tsx entry (no npx indirection) with a hard timeout: execFileSync
    // blocks the event loop, so a hung child would otherwise wedge the whole
    // suite beyond Vitest's control.
    const stdout = execFileSync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/oma-workspaces.ts", "list-workspaces"],
      {
        env: { ...process.env, OMA_SQLITE_PATH: db },
        encoding: "utf8",
        timeout: 60_000,
        killSignal: "SIGKILL",
      },
    );
    expect(stdout).toContain("wrk_default\tDefault workspace");
  });
});
