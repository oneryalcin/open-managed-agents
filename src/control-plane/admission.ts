import { overloaded, rateLimited } from "./errors.ts";
import type { WorkspaceId } from "./workspace.ts";

// Plan 0113 D9: admission limits keyed off authenticated workspace identity.
// Unset limits mean unlimited (today's behavior). Per-workspace hits are 429
// rate_limit_error with retry-after; process-wide hits are 529
// overloaded_error. Counters are in-process, which matches the single-node
// rollout tiers where the deployment app runs.

export interface AdmissionLimitsConfig {
  maxActiveSessionsPerWorkspace?: number;
  maxPendingRuntimeTurnsPerWorkspace?: number;
  maxConcurrentUploadsPerWorkspace?: number;
  maxConcurrentUploads?: number;
  maxConcurrentSseStreamsPerWorkspace?: number;
  maxConcurrentSseStreams?: number;
}

export interface DeploymentAdmissionEnv {
  OMA_MAX_ACTIVE_SESSIONS_PER_WORKSPACE?: string;
  OMA_MAX_PENDING_RUNTIME_TURNS_PER_WORKSPACE?: string;
  OMA_MAX_CONCURRENT_UPLOADS_PER_WORKSPACE?: string;
  OMA_MAX_CONCURRENT_UPLOADS?: string;
  OMA_MAX_CONCURRENT_SSE_STREAMS_PER_WORKSPACE?: string;
  OMA_MAX_CONCURRENT_SSE_STREAMS?: string;
}

export function parseAdmissionLimitsFromEnv(
  env: DeploymentAdmissionEnv,
): AdmissionLimitsConfig {
  return {
    ...limitFromEnv(
      "maxActiveSessionsPerWorkspace",
      "OMA_MAX_ACTIVE_SESSIONS_PER_WORKSPACE",
      env.OMA_MAX_ACTIVE_SESSIONS_PER_WORKSPACE,
    ),
    ...limitFromEnv(
      "maxPendingRuntimeTurnsPerWorkspace",
      "OMA_MAX_PENDING_RUNTIME_TURNS_PER_WORKSPACE",
      env.OMA_MAX_PENDING_RUNTIME_TURNS_PER_WORKSPACE,
    ),
    ...limitFromEnv(
      "maxConcurrentUploadsPerWorkspace",
      "OMA_MAX_CONCURRENT_UPLOADS_PER_WORKSPACE",
      env.OMA_MAX_CONCURRENT_UPLOADS_PER_WORKSPACE,
    ),
    ...limitFromEnv(
      "maxConcurrentUploads",
      "OMA_MAX_CONCURRENT_UPLOADS",
      env.OMA_MAX_CONCURRENT_UPLOADS,
    ),
    ...limitFromEnv(
      "maxConcurrentSseStreamsPerWorkspace",
      "OMA_MAX_CONCURRENT_SSE_STREAMS_PER_WORKSPACE",
      env.OMA_MAX_CONCURRENT_SSE_STREAMS_PER_WORKSPACE,
    ),
    ...limitFromEnv(
      "maxConcurrentSseStreams",
      "OMA_MAX_CONCURRENT_SSE_STREAMS",
      env.OMA_MAX_CONCURRENT_SSE_STREAMS,
    ),
  };
}

function limitFromEnv(
  key: keyof AdmissionLimitsConfig,
  name: string,
  raw: string | undefined,
): Partial<AdmissionLimitsConfig> {
  if (raw === undefined) return {};
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return { [key]: value };
}

// Tracks in-flight operations whose cost is their lifetime (uploads buffering
// in RAM, open SSE streams). acquire() throws the wire-shaped rejection;
// the returned release is idempotent so close/cancel/error paths can all
// call it safely.
export class InFlightGauge {
  private readonly perWorkspaceCounts = new Map<WorkspaceId, number>();
  private total = 0;

  constructor(
    private readonly resource: string,
    private readonly maxPerWorkspace?: number,
    private readonly maxTotal?: number,
  ) {}

  acquire(workspaceId: WorkspaceId): () => void {
    const current = this.perWorkspaceCounts.get(workspaceId) ?? 0;
    if (this.maxPerWorkspace !== undefined && current >= this.maxPerWorkspace) {
      throw rateLimited(
        `Concurrent ${this.resource} limit reached for this workspace; retry later`,
      );
    }
    if (this.maxTotal !== undefined && this.total >= this.maxTotal) {
      throw overloaded();
    }
    this.perWorkspaceCounts.set(workspaceId, current + 1);
    this.total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.perWorkspaceCounts.get(workspaceId) ?? 1;
      if (count <= 1) this.perWorkspaceCounts.delete(workspaceId);
      else this.perWorkspaceCounts.set(workspaceId, count - 1);
      this.total -= 1;
    };
  }

  inFlight(workspaceId: WorkspaceId): number {
    return this.perWorkspaceCounts.get(workspaceId) ?? 0;
  }
}

export interface AdmissionLimits {
  maxActiveSessionsPerWorkspace?: number;
  maxPendingRuntimeTurnsPerWorkspace?: number;
  uploads: InFlightGauge;
  sseStreams: InFlightGauge;
}

export function createAdmissionLimits(
  config: AdmissionLimitsConfig,
): AdmissionLimits {
  return {
    ...(config.maxActiveSessionsPerWorkspace === undefined
      ? {}
      : { maxActiveSessionsPerWorkspace: config.maxActiveSessionsPerWorkspace }),
    ...(config.maxPendingRuntimeTurnsPerWorkspace === undefined
      ? {}
      : {
          maxPendingRuntimeTurnsPerWorkspace:
            config.maxPendingRuntimeTurnsPerWorkspace,
        }),
    uploads: new InFlightGauge(
      "file upload",
      config.maxConcurrentUploadsPerWorkspace,
      config.maxConcurrentUploads,
    ),
    sseStreams: new InFlightGauge(
      "SSE stream",
      config.maxConcurrentSseStreamsPerWorkspace,
      config.maxConcurrentSseStreams,
    ),
  };
}
