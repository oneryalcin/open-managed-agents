import { createHash } from "node:crypto";
import type { ManagedAgentsListPage } from "../../types/common.ts";
import type {
  CreateManagedSessionResourceInput,
  ManagedAgentsDeletedSession,
  ManagedAgentsSession,
  ManagedAgentsSessionFileResource,
} from "../../types/sessions.ts";
import { log } from "../logging.ts";
import type { AgentStore } from "../agents/types.ts";
import {
  EgressPolicyError,
  hasEgressNetworkingConfig,
  parseNetworkingConfig,
} from "../egress/policy.ts";
import type { EnvironmentRow, EnvironmentStore } from "../environments/types.ts";
import { ApiError, invalidRequest, notFound, rateLimited, toApiErrorBody } from "../errors.ts";
import type {
  JsonHttpResponse,
  RequestIdempotencyKey,
  RequestIdempotencyLedger,
} from "../request-idempotency.ts";
import {
  idempotencyCompletion,
  idempotencyConflictResponse,
  idempotencyMismatchError,
  reserveWindow,
  withIdempotencyReservationHeartbeat,
} from "../request-idempotency.ts";
import type {
  RuntimeEventRunner,
  RuntimeSessionFileMount,
} from "../events/types.ts";
import { RuntimeUnsupportedSessionFileResourcesError } from "../events/types.ts";
import type { FileStorage, FileStorageRecord } from "../files/types.ts";
import { newFileId, newSessionId, newSessionResourceId } from "../ids.ts";
import type { WorkspaceId } from "../workspace.ts";
import { parseCreateSession, parseAgentRef } from "./request.ts";
import {
  normalizeSessionFileResources,
  type SessionFileResourceMountInput,
} from "./resources.ts";
import { toManagedSession } from "./serialize.ts";
import type {
  ListSessionsOptions,
  CreateSessionIdempotencyCommit,
  CreateSessionRecord,
  SessionFileMountSnapshotRow,
  SessionRow,
  SessionService,
  SessionStore,
} from "./types.ts";

const MAX_SESSION_FILE_RESOURCES = 10;
const MAX_SESSION_MOUNTED_BYTES = 50 * 1024 * 1024;
const DEFAULT_PENDING_SNAPSHOT_CLEANUP_RETRY_DELAY_MS = 30_000;
const DEFAULT_PENDING_SNAPSHOT_CLEANUP_MAX_ATTEMPTS = 5;

type PendingSnapshotCleanupRow = Pick<
  SessionFileMountSnapshotRow,
  "session_id" | "resource_id" | "snapshot_file_id"
> & {
  created_at: string;
  attempt_count: number;
};

interface PendingSnapshotCleanupRetryContext {
  workspaceId: WorkspaceId;
  sessionId: string;
  resourceId: string;
  snapshotFileId: string;
  retryLabel: string;
  attemptCount: number;
  error: string;
}

interface DeleteSessionRowsResult {
  row: SessionRow;
  deletedSessionOutputFiles?: readonly FileStorageRecord[];
}

/**
 * What the deployment's active sandbox provider can actually enforce (plan
 * 0117e-3). Absent (or all-false) = reject session creation against any
 * environment that grants egress — never run a credential-granting
 * environment without the boundary.
 */
export interface SessionEgressCapability {
  /** docker-local with OMA_ENABLE_EGRESS + a sidecar image. */
  canHonorNetworking: boolean;
  /** A SecretsStore exists (OMA_MASTER_KEY configured). */
  hasSecretsStore: boolean;
}

export interface DefaultSessionServiceOptions {
  maxActiveSessionsPerWorkspace?: number;
  maxFileResources?: number;
  maxMountedBytes?: number;
  egressCapability?: SessionEgressCapability;
  runtime?: Pick<RuntimeEventRunner, "prepareSession" | "closeSession">;
  deleteSessionRows?: (
    workspaceId: WorkspaceId,
    sessionId: string,
  ) => DeleteSessionRowsResult | undefined;
  idempotencyLedger?: RequestIdempotencyLedger;
  createSessionRowsWithIdempotency?: (
    record: CreateSessionRecord,
    idempotency: CreateSessionIdempotencyCommit,
  ) => SessionRow;
  pendingSnapshotCleanupRetryDelayMs?: number;
  pendingSnapshotCleanupMaxAttempts?: number;
  /** 0121 C2: telemetry-only, fired when the active-sessions cap rejects. */
  onAdmissionRejected?: () => void;
}

export class DefaultSessionService implements SessionService {
  private readonly maxActiveSessionsPerWorkspace: number | undefined;
  private readonly egressCapability: SessionEgressCapability | undefined;
  private readonly maxFileResources: number;
  private readonly maxMountedBytes: number;
  private readonly runtime:
    | Pick<RuntimeEventRunner, "prepareSession" | "closeSession">
    | undefined;
  private readonly startupSnapshotDeleteSweep: Promise<void>;
  private readonly startupSnapshotCreateRollbackSweep: Promise<void>;
  private readonly startedAt = new Date().toISOString();
  private readonly deleteSessionRows:
    | ((
        workspaceId: WorkspaceId,
        sessionId: string,
      ) => DeleteSessionRowsResult | undefined)
    | undefined;
  private readonly idempotencyLedger: RequestIdempotencyLedger | undefined;
  private readonly createSessionRowsWithIdempotency:
    | ((
        record: CreateSessionRecord,
        idempotency: CreateSessionIdempotencyCommit,
      ) => SessionRow)
    | undefined;
  private readonly pendingSnapshotCleanupRetryDelayMs: number;
  private readonly pendingSnapshotCleanupMaxAttempts: number;
  private readonly onAdmissionRejected: (() => void) | undefined;
  private readonly pendingSessionCreates = new Map<WorkspaceId, number>();
  private readonly pendingSnapshotDeleteRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly pendingSnapshotCreateRollbackRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly store: SessionStore,
    private readonly agents: AgentStore,
    private readonly environments: EnvironmentStore,
    private readonly files?: FileStorage,
    opts: DefaultSessionServiceOptions = {},
  ) {
    this.maxActiveSessionsPerWorkspace = opts.maxActiveSessionsPerWorkspace;
    this.onAdmissionRejected = opts.onAdmissionRejected;
    this.maxFileResources = opts.maxFileResources ?? MAX_SESSION_FILE_RESOURCES;
    this.maxMountedBytes = opts.maxMountedBytes ?? MAX_SESSION_MOUNTED_BYTES;
    this.egressCapability = opts.egressCapability;
    this.runtime = opts.runtime;
    this.deleteSessionRows = opts.deleteSessionRows;
    this.idempotencyLedger = opts.idempotencyLedger;
    this.createSessionRowsWithIdempotency = opts.createSessionRowsWithIdempotency;
    if (this.idempotencyLedger && !this.createSessionRowsWithIdempotency) {
      throw new Error(
        "DefaultSessionService requires createSessionRowsWithIdempotency when idempotencyLedger is configured",
      );
    }
    this.pendingSnapshotCleanupRetryDelayMs =
      opts.pendingSnapshotCleanupRetryDelayMs ??
      DEFAULT_PENDING_SNAPSHOT_CLEANUP_RETRY_DELAY_MS;
    this.pendingSnapshotCleanupMaxAttempts =
      opts.pendingSnapshotCleanupMaxAttempts ??
      DEFAULT_PENDING_SNAPSHOT_CLEANUP_MAX_ATTEMPTS;
    if (this.pendingSnapshotCleanupMaxAttempts < 1) {
      throw invalidRequest("pendingSnapshotCleanupMaxAttempts must be at least 1");
    }
    this.startupSnapshotDeleteSweep = this.sweepPendingInternalSnapshotDeletes().catch(
      (error) => {
        log.warn("snapshot_delete_startup_sweep_failed", { error });
      },
    );
    this.startupSnapshotCreateRollbackSweep =
      this.sweepPendingInternalSnapshotCreateRollbacks({
        createdBefore: this.startedAt,
      }).catch((error) => {
        log.warn("snapshot_create_rollback_startup_sweep_failed", { error });
      });
  }

  async create(
    workspaceId: WorkspaceId,
    input: unknown,
  ): Promise<ManagedAgentsSession> {
    return this.createInternal(workspaceId, input);
  }

  async createIdempotent(
    workspaceId: WorkspaceId,
    input: unknown,
    idempotency: RequestIdempotencyKey,
    opts: { requestId?: string } = {},
  ): Promise<JsonHttpResponse> {
    if (!this.idempotencyLedger) {
      return { status: 200, body: await this.createInternal(workspaceId, input) };
    }
    const reservation = this.idempotencyLedger.reserveIdempotencyKey({
      ...idempotency,
      workspaceId,
      ...reserveWindow(),
    });
    if (reservation.kind === "replay") {
      return {
        status: reservation.responseStatus,
        body: reservation.responseBody,
      };
    }
    if (reservation.kind === "fingerprint_mismatch") {
      throw idempotencyMismatchError();
    }
    if (reservation.kind === "in_progress") {
      return idempotencyConflictResponse(opts.requestId);
    }

    try {
      const session = await this.createInternal(workspaceId, input, {
        idempotency,
      });
      return { status: 200, body: session };
    } catch (error) {
      if (shouldReleaseIdempotencyReservation(error)) {
        this.idempotencyLedger.releaseIdempotencyReservation({
          ...idempotency,
          workspaceId,
        });
        throw unwrapIdempotentCreateError(error);
      }
      if (error instanceof ApiError && error.status < 500) {
        const body = toApiErrorBody(error, opts.requestId);
        this.idempotencyLedger.completeIdempotency(
          idempotencyCompletion(workspaceId, idempotency, {
            status: error.status,
            body,
          }),
        );
        return { status: error.status, body };
      }
      throw error;
    }
  }

  private async createInternal(
    workspaceId: WorkspaceId,
    input: unknown,
    opts: { idempotency?: RequestIdempotencyKey } = {},
  ): Promise<ManagedAgentsSession> {
    // 0113 D9: reserve before the async file-resource preparation below, not
    // just before the row insert. Counting rows alone lets N concurrent
    // creates with resources all pass the cap while none has inserted yet;
    // the in-flight reservation closes that window and bounds the expensive
    // prep itself.
    const release = this.reserveSessionCreateSlot(workspaceId);
    try {
      return await this.createInternalReserved(workspaceId, input, opts);
    } finally {
      release();
    }
  }

  private reserveSessionCreateSlot(workspaceId: WorkspaceId): () => void {
    const cap = this.maxActiveSessionsPerWorkspace;
    if (cap === undefined) return () => {};
    const pending = this.pendingSessionCreates.get(workspaceId) ?? 0;
    if (this.store.countActive(workspaceId) + pending >= cap) {
      this.onAdmissionRejected?.();
      throw rateLimited(
        "Concurrent active session limit reached for this workspace; archive or delete sessions, or retry later",
      );
    }
    this.pendingSessionCreates.set(workspaceId, pending + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.pendingSessionCreates.get(workspaceId) ?? 1;
      if (current <= 1) this.pendingSessionCreates.delete(workspaceId);
      else this.pendingSessionCreates.set(workspaceId, current - 1);
    };
  }

  // Fail-closed egress gate (plan 0117e-3, the slice's key safety property):
  // an environment granting egress (OMA `networking.allow`/`.credentials`
  // shape) must be REJECTED at session create when the deployment cannot
  // honor it — silently running such a session at --network none (or worse,
  // with credentials it cannot inject) hides a broken boundary from the
  // operator. Hosted-shape networking (`{type:"unrestricted"}`) stays what it
  // has always been in OMA: ignored, --network none.
  private assertEgressHonorable(environment: EnvironmentRow): void {
    if (!hasEgressNetworkingConfig(environment.config)) return;
    let policy;
    try {
      policy = parseNetworkingConfig(environment.config);
    } catch (error) {
      if (error instanceof EgressPolicyError) {
        throw invalidRequest(
          `Environment ${environment.id} has an invalid networking config: ${error.message}`,
        );
      }
      throw error;
    }
    if (policy === undefined) return;
    if (this.egressCapability?.canHonorNetworking !== true) {
      throw invalidRequest(
        `Environment ${environment.id} grants network egress, but this deployment cannot honor it ` +
          "(requires OMA_SANDBOX_PROVIDER=docker-local with OMA_ENABLE_EGRESS=true and OMA_EGRESS_SIDECAR_IMAGE)",
      );
    }
    if (policy.credentials.length > 0 && !this.egressCapability.hasSecretsStore) {
      throw invalidRequest(
        `Environment ${environment.id} grants credentials, but this deployment has no secrets store ` +
          "(set OMA_MASTER_KEY or OMA_MASTER_KEY_FILE)",
      );
    }
  }

  private async createInternalReserved(
    workspaceId: WorkspaceId,
    input: unknown,
    opts: { idempotency?: RequestIdempotencyKey } = {},
  ): Promise<ManagedAgentsSession> {
    const req = parseCreateSession(input);
    const agentRef = parseAgentRef(req.agent);
    const agent = this.agents.retrieveAny(workspaceId, agentRef.id);
    if (!agent) {
      throw invalidRequest(`Agent ${agentRef.id} not found`);
    }
    if (agent.archived_at !== null) {
      throw invalidRequest(
        `agent ${agentRef.id} is archived and cannot be used to create a session`,
      );
    }
    if (agentRef.version !== undefined && agentRef.version !== agent.version) {
      throw invalidRequest(
        `Agent ${agentRef.id} has version ${agent.version}; requested version ${agentRef.version} not found`,
      );
    }
    const environment = this.environments.retrieve(workspaceId, req.environment_id);
    if (!environment) {
      throw invalidRequest(`Environment ${req.environment_id} not found`);
    }
    this.assertEgressHonorable(environment);

    const now = new Date().toISOString();
    const sessionId = newSessionId();
    let externalSideEffectsStarted = false;
    const { resources, snapshots, mounts } = await this.prepareFileResources(
      workspaceId,
      sessionId,
      req.resources ?? [],
      now,
      {
        idempotency: opts.idempotency,
        onExternalSideEffect: () => {
          externalSideEffectsStarted = true;
        },
      },
    );
    const row: SessionRow = {
      id: sessionId,
      workspace_id: workspaceId,
      type: "session",
      agent: {
        type: "agent",
        id: agent.id,
        version: agent.version,
      },
      environment_id: environment.id,
      status: "idle",
      title: req.title ?? null,
      metadata: req.metadata ?? {},
      created_at: now,
      updated_at: now,
      archived_at: null,
      usage: null,
      resources,
    };
    const sessionSnapshots = snapshots.map((snapshot) => ({
      ...snapshot,
      session_id: row.id,
    }));
    let runtimePrepared = false;
    try {
      if (mounts.length > 0 && this.runtime?.prepareSession) {
        externalSideEffectsStarted = true;
        await this.withIdempotencyHeartbeat(
          workspaceId,
          opts.idempotency,
          Promise.resolve(
            this.runtime.prepareSession(workspaceId, row.id, {
              fileMounts: mounts,
              environmentId: row.environment_id,
              agent: row.agent,
            }),
          ),
        );
        runtimePrepared = true;
      }
      const record = { row, snapshots: sessionSnapshots };
      if (opts.idempotency && this.idempotencyLedger) {
        const response = toManagedSession(row);
        const completion = idempotencyCompletion(
          workspaceId,
          opts.idempotency,
          { status: 200, body: response },
          { type: "session", id: row.id },
        );
        const created = this.createSessionRowsWithIdempotency!(record, {
          complete: () => {
            this.idempotencyLedger?.completeIdempotencyInTransaction(completion);
          },
        });
        return toManagedSession(created);
      }
      return toManagedSession(this.store.create(record));
    } catch (error) {
      if (runtimePrepared || mounts.length > 0) {
        await this.closeRuntimeBestEffort(workspaceId, row.id);
      }
      await this.sweepPendingInternalSnapshotCreateRollbacks(
        workspaceId,
        row.id,
      ).catch((cleanupError) => {
        log.warn("snapshot_create_rollback_sweep_failed", { error: cleanupError });
      });
      if (isUnsupportedFileResourceRuntime(error)) {
        const unsupported = invalidRequest(
          "Session file resources are not supported by the configured runtime.",
        );
        if (opts.idempotency) {
          throw new ReleaseIdempotencyReservationError(unsupported);
        }
        throw unsupported;
      }
      if (opts.idempotency && externalSideEffectsStarted) {
        throw new ReleaseIdempotencyReservationError(error);
      }
      throw error;
    }
  }

  retrieve(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): ManagedAgentsSession {
    const row = this.store.retrieveAny(workspaceId, sessionId);
    if (!row) {
      throw notFound(`Session ${sessionId} not found`);
    }
    return toManagedSession(row);
  }

  async delete(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<ManagedAgentsDeletedSession> {
    const result =
      this.deleteSessionRows?.(workspaceId, sessionId) ??
      this.deleteSessionRowsWithDefaultStore(workspaceId, sessionId);
    if (!result) {
      throw notFound(`Session ${sessionId} not found`);
    }
    await this.sweepPendingInternalSnapshotDeletes(workspaceId, sessionId).catch(
      (error) => {
        log.warn("snapshot_delete_sweep_failed", { error });
      },
    );
    await this.cleanupDeletedSessionOutputs(
      workspaceId,
      sessionId,
      result.deletedSessionOutputFiles,
    );
    return { id: result.row.id, type: "session_deleted" };
  }

  private deleteSessionRowsWithDefaultStore(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): DeleteSessionRowsResult | undefined {
    const row = this.store.delete(workspaceId, sessionId);
    return row ? { row } : undefined;
  }

  private async cleanupDeletedSessionOutputs(
    workspaceId: WorkspaceId,
    sessionId: string,
    deletedFiles: readonly FileStorageRecord[] | undefined,
  ): Promise<void> {
    try {
      if (deletedFiles !== undefined && hasRecordObjectDelete(this.files)) {
        await this.files.deleteObjectsForRecords(deletedFiles);
        return;
      }
      await this.files?.deleteSessionOutputs(workspaceId, sessionId);
    } catch (error) {
      log.warn("session_output_cleanup_failed", {
        workspaceId,
        sessionId,
        error,
      });
    }
  }

  async sweepPendingInternalSnapshotDeletes(
    workspaceId?: WorkspaceId,
    sessionId?: string,
  ): Promise<void> {
    await this.sweepPendingSnapshotCleanup({
      workspaceId,
      sessionId,
      listWorkspaces: () => this.store.listPendingInternalSnapshotDeleteWorkspaces(),
      getRows: (pendingWorkspaceId, pendingSessionId) =>
        this.store.getPendingInternalSnapshotDeletes(
          pendingWorkspaceId,
          pendingSessionId,
        ),
      clearRow: (rowWorkspaceId, rowSessionId, resourceId) =>
        this.store.clearPendingInternalSnapshotDelete(
          rowWorkspaceId,
          rowSessionId,
          resourceId,
        ),
      recordAttempt: (rowWorkspaceId, rowSessionId, resourceId, attemptedAt, error) =>
        this.store.recordPendingInternalSnapshotDeleteAttempt(
          rowWorkspaceId,
          rowSessionId,
          resourceId,
          attemptedAt,
          error,
        ),
      scheduleRetry: (rowWorkspaceId, rowSessionId) =>
        this.schedulePendingSnapshotCleanupRetry({
          workspaceId: rowWorkspaceId,
          sessionId: rowSessionId,
          timers: this.pendingSnapshotDeleteRetryTimers,
          retryLabel: "delete",
          sweep: () =>
            this.sweepPendingInternalSnapshotDeletes(
              rowWorkspaceId,
              rowSessionId,
            ),
        }),
      retryLabel: "delete",
    });
  }

  async drainStartupSnapshotSweepsForTest(): Promise<void> {
    await this.startupSnapshotDeleteSweep;
    await this.startupSnapshotCreateRollbackSweep;
  }

  async sweepPendingInternalSnapshotCreateRollbacks(
    workspaceIdOrOpts?:
      | WorkspaceId
      | { workspaceId?: WorkspaceId; sessionId?: string; createdBefore?: string },
    sessionId?: string,
  ): Promise<void> {
    const opts =
      typeof workspaceIdOrOpts === "object"
        ? workspaceIdOrOpts
        : { workspaceId: workspaceIdOrOpts, sessionId };
    await this.sweepPendingSnapshotCleanup({
      workspaceId: opts.workspaceId,
      sessionId: opts.sessionId,
      createdBefore: opts.createdBefore,
      listWorkspaces: () =>
        this.store.listPendingInternalSnapshotCreateRollbackWorkspaces(),
      getRows: (pendingWorkspaceId, pendingSessionId) =>
        this.store.getPendingInternalSnapshotCreateRollbacks(
          pendingWorkspaceId,
          pendingSessionId,
        ),
      clearRow: (rowWorkspaceId, rowSessionId, resourceId) =>
        this.store.clearPendingInternalSnapshotCreateRollback(
          rowWorkspaceId,
          rowSessionId,
          resourceId,
        ),
      recordAttempt: (rowWorkspaceId, rowSessionId, resourceId, attemptedAt, error) =>
        this.store.recordPendingInternalSnapshotCreateRollbackAttempt(
          rowWorkspaceId,
          rowSessionId,
          resourceId,
          attemptedAt,
          error,
        ),
      scheduleRetry: (rowWorkspaceId, rowSessionId) =>
        this.schedulePendingSnapshotCleanupRetry({
          workspaceId: rowWorkspaceId,
          sessionId: rowSessionId,
          timers: this.pendingSnapshotCreateRollbackRetryTimers,
          retryLabel: "create rollback",
          sweep: () =>
            this.sweepPendingInternalSnapshotCreateRollbacks({
              workspaceId: rowWorkspaceId,
              sessionId: rowSessionId,
            }),
        }),
      retryLabel: "create rollback",
    });
  }

  private async sweepPendingSnapshotCleanup(
    opts: {
      workspaceId?: WorkspaceId;
      sessionId?: string;
      createdBefore?: string;
      listWorkspaces: () => WorkspaceId[];
      getRows: (
        workspaceId: WorkspaceId,
        sessionId?: string,
      ) => PendingSnapshotCleanupRow[];
      clearRow: (
        workspaceId: WorkspaceId,
        sessionId: string,
        resourceId: string,
      ) => void;
      recordAttempt: (
        workspaceId: WorkspaceId,
        sessionId: string,
        resourceId: string,
        attemptedAt: string,
        error: string,
      ) => void;
      scheduleRetry: (workspaceId: WorkspaceId, sessionId: string) => void;
      retryLabel: string;
    },
  ): Promise<void> {
    if (!this.files) return;
    const workspaces =
      opts.workspaceId === undefined ? opts.listWorkspaces() : [opts.workspaceId];
    for (const pendingWorkspaceId of workspaces) {
      const pending = opts.getRows(
        pendingWorkspaceId,
        opts.workspaceId === undefined ? undefined : opts.sessionId,
      );
      for (const row of pending) {
        if (opts.createdBefore !== undefined && row.created_at >= opts.createdBefore) {
          continue;
        }
        if (row.attempt_count >= this.pendingSnapshotCleanupMaxAttempts) {
          continue;
        }
        try {
          await this.files.deleteInternalSnapshot(
            pendingWorkspaceId,
            row.snapshot_file_id,
          );
          opts.clearRow(pendingWorkspaceId, row.session_id, row.resource_id);
        } catch (error) {
          const message = errorMessage(error);
          const attemptedAt = new Date().toISOString();
          const nextAttemptCount = row.attempt_count + 1;
          opts.recordAttempt(
            pendingWorkspaceId,
            row.session_id,
            row.resource_id,
            attemptedAt,
            message,
          );
          const context = {
            workspaceId: pendingWorkspaceId,
            sessionId: row.session_id,
            resourceId: row.resource_id,
            snapshotFileId: row.snapshot_file_id,
            retryLabel: opts.retryLabel,
            attemptCount: nextAttemptCount,
            error: message,
          };
          if (nextAttemptCount >= this.pendingSnapshotCleanupMaxAttempts) {
            this.warnPendingSnapshotCleanupRetryCap(context);
            continue;
          }
          opts.scheduleRetry(pendingWorkspaceId, row.session_id);
        }
      }
    }
  }

  private schedulePendingSnapshotCleanupRetry(
    opts: {
      workspaceId: WorkspaceId;
      sessionId: string;
      timers: Map<string, ReturnType<typeof setTimeout>>;
      retryLabel: string;
      sweep: () => Promise<void>;
    },
  ): void {
    const key = JSON.stringify([opts.workspaceId, opts.sessionId]);
    if (opts.timers.has(key)) return;
    const timer = setTimeout(() => {
      opts.timers.delete(key);
      void opts.sweep().catch((error) => {
        log.warn("snapshot_cleanup_retry_failed", {
          retryLabel: opts.retryLabel,
          error,
        });
        this.schedulePendingSnapshotCleanupRetry(opts);
      });
    }, this.pendingSnapshotCleanupRetryDelayMs);
    timer.unref?.();
    opts.timers.set(key, timer);
  }

  private warnPendingSnapshotCleanupRetryCap(
    context: PendingSnapshotCleanupRetryContext,
  ): void {
    log.warn("snapshot_cleanup_retry_cap_reached", {
      retryLabel: context.retryLabel,
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      resourceId: context.resourceId,
      snapshotFileId: context.snapshotFileId,
      attemptCount: context.attemptCount,
      maxAttempts: this.pendingSnapshotCleanupMaxAttempts,
      error: context.error,
    });
  }

  list(
    workspaceId: WorkspaceId,
    opts: ListSessionsOptions = {},
  ): ManagedAgentsListPage<ManagedAgentsSession> {
    const page = this.store.list(workspaceId, opts);
    return {
      data: page.data.map(toManagedSession),
      has_more: page.has_more,
      next_page: page.next_page,
    };
  }

  private async prepareFileResources(
    workspaceId: WorkspaceId,
    sessionId: string,
    resources: CreateManagedSessionResourceInput[],
    now: string,
    opts: {
      idempotency?: RequestIdempotencyKey;
      onExternalSideEffect?: () => void;
    } = {},
  ): Promise<{
    resources: ManagedAgentsSessionFileResource[];
    snapshots: Array<Omit<SessionFileMountSnapshotRow, "session_id">>;
    mounts: RuntimeSessionFileMount[];
  }> {
    if (resources.length === 0) {
      return { resources: [], snapshots: [], mounts: [] };
    }
    if (!this.files) {
      throw invalidRequest("File resources are not supported by this server.");
    }
    if (resources.length > this.maxFileResources) {
      throw invalidRequest(
        `Session file resources exceed the ${this.maxFileResources} file limit`,
      );
    }

    const normalized = normalizeSessionFileResources(
      resources.map(
        (resource): SessionFileResourceMountInput => ({
          fileId: resource.file_id,
          mountPath: resource.mount_path,
        }),
      ),
    );
    const prepared: Array<{
      source: FileStorageRecord;
      bytes: Uint8Array;
      sha256: string;
      resourceId: string;
      mountPath: string;
    }> = [];
    let totalBytes = 0;
    for (const resource of normalized) {
      const source = await this.withIdempotencyHeartbeat(
        workspaceId,
        opts.idempotency,
        this.files.retrieveMetadata(workspaceId, resource.fileId),
      );
      if (!source) {
        throw invalidRequest(`File ${resource.fileId} not found`);
      }
      const stream = await this.withIdempotencyHeartbeat(
        workspaceId,
        opts.idempotency,
        this.files.openBytes(workspaceId, resource.fileId),
      );
      if (!stream) {
        throw invalidRequest(`File ${resource.fileId} not found`);
      }
      const bytes = await this.withIdempotencyHeartbeat(
        workspaceId,
        opts.idempotency,
        consumeBytes(stream),
      );
      const sha256 = sha256Hex(bytes);
      if (sha256 !== source.sha256) {
        throw invalidRequest(`File ${resource.fileId} failed integrity validation`);
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > this.maxMountedBytes) {
        throw invalidRequest(
          `Session file resources exceed the ${limitLabel(this.maxMountedBytes)} mounted byte limit`,
        );
      }
      prepared.push({
        source,
        bytes,
        sha256,
        resourceId: newSessionResourceId(),
        mountPath: resource.mountPath,
      });
    }

    const createdSnapshots: Array<Omit<SessionFileMountSnapshotRow, "session_id">> = [];
    try {
      for (const item of prepared) {
        const snapshotFileId = newFileId();
        const rollbackRow: SessionFileMountSnapshotRow = {
          workspace_id: workspaceId,
          session_id: sessionId,
          resource_id: item.resourceId,
          file_id: item.source.metadata.id,
          mount_path: item.mountPath,
          snapshot_file_id: snapshotFileId,
          sha256: item.sha256,
          size_bytes: item.bytes.byteLength,
        };
        this.store.recordPendingInternalSnapshotCreateRollback(
          rollbackRow,
          now,
        );
        opts.onExternalSideEffect?.();
        const snapshot = await this.withIdempotencyHeartbeat(
          workspaceId,
          opts.idempotency,
          this.files.createInternalSnapshot(workspaceId, {
            fileId: snapshotFileId,
            filename: item.source.metadata.filename,
            mimeType: item.source.metadata.mime_type,
            scopeId: item.resourceId,
            body: item.bytes,
          }),
        );
        if (snapshot.metadata.id !== snapshotFileId) {
          throw new Error(
            `FileStorage returned internal snapshot id ${snapshot.metadata.id}; expected ${snapshotFileId}`,
          );
        }
        createdSnapshots.push({
          workspace_id: workspaceId,
          resource_id: item.resourceId,
          file_id: item.source.metadata.id,
          mount_path: item.mountPath,
          snapshot_file_id: snapshot.metadata.id,
          sha256: snapshot.sha256,
          size_bytes: snapshot.metadata.size_bytes,
        });
      }
    } catch (error) {
      await this.sweepPendingInternalSnapshotCreateRollbacks(
        workspaceId,
        sessionId,
      ).catch((cleanupError) => {
        log.warn("snapshot_create_rollback_sweep_failed", { error: cleanupError });
      });
      throw error;
    }

    return {
      resources: prepared.map((item) => ({
        id: item.resourceId,
        type: "file",
        file_id: item.source.metadata.id,
        mount_path: item.mountPath,
        created_at: now,
        updated_at: now,
      })),
      snapshots: createdSnapshots,
      mounts: createdSnapshots.map((snapshot, index) => ({
        mountPath: snapshot.mount_path,
        snapshotFileId: snapshot.snapshot_file_id,
        sha256: snapshot.sha256,
        sizeBytes: snapshot.size_bytes,
        bytes: prepared[index]!.bytes,
      })),
    };
  }

  private async closeRuntimeBestEffort(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<void> {
    try {
      await this.runtime?.closeSession?.(workspaceId, sessionId);
    } catch {
      // The row has not committed yet; snapshot cleanup below is the
      // authoritative control-plane rollback path for this create.
    }
  }

  private async withIdempotencyHeartbeat<T>(
    workspaceId: WorkspaceId,
    idempotency: RequestIdempotencyKey | undefined,
    operation: Promise<T>,
  ): Promise<T> {
    return withIdempotencyReservationHeartbeat(
      this.idempotencyLedger,
      idempotency === undefined ? undefined : { ...idempotency, workspaceId },
      operation,
    );
  }

}

class ReleaseIdempotencyReservationError extends Error {
  constructor(readonly inner: unknown) {
    super(errorMessage(inner));
    this.name = "ReleaseIdempotencyReservationError";
  }
}

function shouldReleaseIdempotencyReservation(error: unknown): boolean {
  if (error instanceof ReleaseIdempotencyReservationError) return true;
  // 429 admission rejections are transient: completing the key would replay
  // the 429 forever, even after capacity frees. Release so the same-key retry
  // re-executes (0113 D9).
  if (error instanceof ApiError && error.status === 429) return true;
  if (error instanceof ApiError && error.status < 500) return false;
  return true;
}

function unwrapIdempotentCreateError(error: unknown): unknown {
  return error instanceof ReleaseIdempotencyReservationError
    ? error.inner
    : error;
}

async function consumeBytes(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    totalLength += chunk.byteLength;
  }
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function limitLabel(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  return `${bytes} bytes`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasRecordObjectDelete(
  files: FileStorage | undefined,
): files is FileStorage & {
  deleteObjectsForRecords(records: readonly FileStorageRecord[]): Promise<void>;
} {
  return typeof (
    files as { deleteObjectsForRecords?: unknown } | undefined
  )?.deleteObjectsForRecords === "function";
}

function isUnsupportedFileResourceRuntime(error: unknown): boolean {
  return error instanceof RuntimeUnsupportedSessionFileResourcesError;
}
