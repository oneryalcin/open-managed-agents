// Operator CLI for workspace and API-key provisioning (plan 0113 D8).
//
// Runs against the live server's SQLite database through
// openWorkspaceStoreForProvisioning: same WAL/busy_timeout pragmas, no
// .oma.lock, so keys take effect without a server restart.
//
//   OMA_SQLITE_PATH=/path/to/oma.db npx tsx scripts/oma-workspaces.ts <command>
import { pathToFileURL } from "node:url";
import {
  openWorkspaceStoreForProvisioning,
} from "../src/control-plane/deployment-storage.ts";
import type { SqliteWorkspaceStore } from "../src/control-plane/workspaces/store.ts";

const USAGE = `Usage: npx tsx scripts/oma-workspaces.ts <command> [args]

The database path comes from OMA_SQLITE_PATH or --db <path> (the same file
the OMA server uses). Commands run safely while the server is up; minted and
revoked keys take effect without a restart.

Commands:
  create-workspace <name>            Create a workspace and print its id
  list-workspaces                    List workspace ids and names
  mint-key <workspace_id> [label]    Mint an API key. The plaintext is printed
                                     ONCE and never stored; only its SHA-256
                                     digest exists at rest.
  list-keys <workspace_id>           List key digests, labels, revocation state
  revoke-key <key_sha256>            Revoke a key (tombstone; audit row kept)
`;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runWorkspacesCli(
  argv: readonly string[],
  env: { OMA_SQLITE_PATH?: string },
): CliResult {
  const args = [...argv];
  let sqlitePath = env.OMA_SQLITE_PATH;
  const dbFlag = args.indexOf("--db");
  if (dbFlag !== -1) {
    sqlitePath = args[dbFlag + 1];
    if (sqlitePath === undefined) return fail("--db requires a path");
    args.splice(dbFlag, 2);
  }
  const [command, ...rest] = args;
  if (command === undefined || command === "help" || command === "--help") {
    return { code: command === undefined ? 1 : 0, stdout: USAGE, stderr: "" };
  }
  if (sqlitePath === undefined || sqlitePath.trim() === "") {
    return fail("Set OMA_SQLITE_PATH or pass --db <path>");
  }

  let store: SqliteWorkspaceStore;
  try {
    store = openWorkspaceStoreForProvisioning(sqlitePath);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  try {
    return dispatch(store, command, rest);
  } finally {
    store.close();
  }
}

function dispatch(
  store: SqliteWorkspaceStore,
  command: string,
  args: string[],
): CliResult {
  switch (command) {
    case "create-workspace": {
      const [name] = args;
      if (!name) return fail("create-workspace requires a name");
      const workspace = store.createWorkspace(name);
      return ok(
        `Created workspace ${workspace.workspace_id} (${workspace.name})\n` +
          `Next: mint-key ${workspace.workspace_id}\n`,
      );
    }
    case "list-workspaces": {
      const rows = store.listWorkspaces();
      return ok(
        rows.map((row) => `${row.workspace_id}\t${row.name}`).join("\n") + "\n",
      );
    }
    case "mint-key": {
      const [workspaceId, label = "default"] = args;
      if (!workspaceId) return fail("mint-key requires a workspace_id");
      let minted;
      try {
        minted = store.mintKey(workspaceId, label);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
      return ok(
        `Workspace:  ${minted.workspaceId}\n` +
          `Label:      ${minted.label}\n` +
          `Key sha256: ${minted.keySha256}\n` +
          `API key:    ${minted.plaintextKey}\n` +
          `\n` +
          `This is the ONLY time the key is shown. Store it now.\n` +
          `Clients send it as the x-api-key header.\n`,
      );
    }
    case "list-keys": {
      const [workspaceId] = args;
      if (!workspaceId) return fail("list-keys requires a workspace_id");
      if (!store.getWorkspace(workspaceId)) {
        return fail(`Workspace not found: ${workspaceId}`);
      }
      const rows = store.listKeys(workspaceId);
      const lines = rows.map(
        (row) =>
          `${row.key_sha256}\t${row.label}\t` +
          (row.revoked_at === null ? "active" : `revoked ${row.revoked_at}`),
      );
      return ok(lines.length === 0 ? "(no keys)\n" : lines.join("\n") + "\n");
    }
    case "revoke-key": {
      const [keySha256] = args;
      if (!keySha256) return fail("revoke-key requires a key_sha256");
      const existing = store.getKey(keySha256);
      if (existing === undefined) return fail(`Key not found: ${keySha256}`);
      if (existing.revoked_at !== null) {
        return ok(`Key was already revoked at ${existing.revoked_at}\n`);
      }
      store.revokeKey(keySha256);
      return ok(
        `Revoked ${keySha256} (workspace ${existing.workspace_id}).\n` +
          `New requests with this key now fail with 401. Already-open SSE\n` +
          `streams run until disconnect; restart the server to sever them.\n`,
      );
    }
    default:
      return fail(`Unknown command: ${command}\n\n${USAGE}`);
  }
}

function ok(stdout: string): CliResult {
  return { code: 0, stdout, stderr: "" };
}

function fail(message: string): CliResult {
  return { code: 1, stdout: "", stderr: `${message}\n` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = runWorkspacesCli(process.argv.slice(2), process.env);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
