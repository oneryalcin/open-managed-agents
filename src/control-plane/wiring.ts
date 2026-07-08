import { randomBytes } from "node:crypto";
import type { ManagedAgentsCustomTool } from "../types/agents.ts";
import { SqliteAgentStore } from "./agents/store.ts";
import {
  hasEgressNetworkingConfig,
  resolveSessionEgressBundle,
} from "./egress/policy.ts";
import { SqliteEnvironmentStore } from "./environments/store.ts";
import type { FileStorage } from "./files/types.ts";
import type { SecretsStore } from "./secrets/types.ts";
import { DEFAULT_SIDECAR_PORT } from "./sessions/pi/sandbox/docker-egress.ts";
import type { EgressBundleResolver } from "./sessions/pi/sandbox/docker.ts";
import type { PiSessionFileMountResolver } from "./sessions/pi/runner.ts";
import { SqliteSessionStore } from "./sessions/store.ts";
import type { SessionFileMountSnapshotRow } from "./sessions/types.ts";

/**
 * Per-session egress bundle resolution (plan 0117e-3, Option A): session ->
 * environment -> networking config -> secrets, resolved at sandbox-create
 * time inside the docker factory closure. Returns undefined for a session
 * whose environment grants no egress — including hosted-shape networking
 * (`{type:"unrestricted"}`), which OMA has always ignored. Mints a fresh
 * URL-safe proxy-auth token per session.
 */
export function createSessionEgressBundleResolver(stores: {
  sessions: Pick<SqliteSessionStore, "retrieveAny">;
  environments: Pick<SqliteEnvironmentStore, "retrieve">;
  secrets?: Pick<SecretsStore, "reveal">;
}): EgressBundleResolver {
  return async (workspaceId, sessionId, context) => {
    // Normal prompt-time sandbox creation reads the persisted session row. The
    // file-resource create path prepares its sandbox before that row is
    // committed, so DefaultSessionService passes the already-validated
    // environmentId as a creation-time hint.
    const environmentId = context?.environmentId;
    const session =
      environmentId === undefined
        ? stores.sessions.retrieveAny(workspaceId, sessionId)
        : undefined;
    if (environmentId === undefined && !session) return undefined;
    const resolvedEnvironmentId = environmentId ?? session!.environment_id;
    const environment = stores.environments.retrieve(
      workspaceId,
      resolvedEnvironmentId,
    );
    if (!environment) return undefined;
    if (!hasEgressNetworkingConfig(environment.config)) return undefined;
    const resolved = resolveSessionEgressBundle({
      environmentConfig: environment.config,
      revealSecret: (name) => stores.secrets?.reveal(workspaceId, name),
      listenPort: DEFAULT_SIDECAR_PORT,
      proxyAuthToken: randomBytes(24).toString("hex"),
    });
    if (resolved === undefined) return undefined;
    return { bundle: resolved.bundle, sandboxEnv: resolved.sandboxEnv };
  };
}

export function createFileMountResolver(
  sessionStore: Pick<SqliteSessionStore, "getFileMountSnapshots">,
  fileStorage: Pick<FileStorage, "openInternalSnapshotBytes">,
): PiSessionFileMountResolver {
  return async (workspaceId, sessionId) => {
    const snapshots = sessionStore.getFileMountSnapshots(workspaceId, sessionId);
    return Promise.all(
      snapshots.map(async (snapshot) =>
        snapshotToRuntimeMount(workspaceId, fileStorage, snapshot),
      ),
    );
  };
}

async function snapshotToRuntimeMount(
  workspaceId: string,
  fileStorage: Pick<FileStorage, "openInternalSnapshotBytes">,
  snapshot: SessionFileMountSnapshotRow,
) {
  const bytes = await fileStorage.openInternalSnapshotBytes(
    workspaceId,
    snapshot.snapshot_file_id,
  );
  if (!bytes) {
    throw new Error(
      `Session file snapshot ${snapshot.snapshot_file_id} not found`,
    );
  }
  return {
    mountPath: snapshot.mount_path,
    snapshotFileId: snapshot.snapshot_file_id,
    sha256: snapshot.sha256,
    sizeBytes: snapshot.size_bytes,
    bytes,
  };
}

export function createStoreBackedCustomToolsProvider(opts: {
  sessions: Pick<SqliteSessionStore, "retrieveAny">;
  agents: Pick<SqliteAgentStore, "retrieveAny">;
}): (
  workspaceId: string,
  sessionId: string,
  context?: { agentId?: string },
) => readonly ManagedAgentsCustomTool[] {
  return (workspaceId, sessionId, context) => {
    const session = opts.sessions.retrieveAny(workspaceId, sessionId);
    const agentId = session?.agent.id ?? context?.agentId;
    if (!agentId) return [];
    const agent = opts.agents.retrieveAny(workspaceId, agentId);
    if (!agent) return [];
    const tools = agent.tools.filter(
      (tool): tool is ManagedAgentsCustomTool => tool.type === "custom",
    );
    return tools;
  };
}
