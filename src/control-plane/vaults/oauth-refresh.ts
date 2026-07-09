import { Buffer } from "node:buffer";
import type { WorkspaceId } from "../workspace.ts";
import type {
  PersistAuthHintInput,
  PersistAuthHintResult,
  PersistOauthRefreshResult,
  VaultOauthRefreshState,
  VaultStore,
} from "./types.ts";

export const OAUTH_REFRESH_TIMEOUT_MS = 30_000;
export const OAUTH_REFRESH_MAX_BODY_BYTES = 64 * 1024;
export const OAUTH_REFRESH_LEAD_MS = 5 * 60_000;
export const OAUTH_REFRESH_FLOOR_MS = 30_000;
export const OAUTH_REFRESH_MAX_BACKOFF_MS = 15 * 60_000;
export const OAUTH_REFRESH_LONG_LIVED_RECHECK_MS = 15 * 60_000;
export const OAUTH_FORCED_REFRESH_FLOOR_MS = 60_000;

const PERMANENT_OAUTH_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "invalid_client",
  "unauthorized_client",
  "invalid_scope",
  "unsupported_grant_type",
]);

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RefreshCoordinatorOptions {
  store: VaultStore;
  fetch: FetchLike;
  now?: () => Date;
  timeoutMs?: number;
  maxBodyBytes?: number;
  random?: () => number;
}

export interface RefreshCredentialInput {
  workspaceId: WorkspaceId;
  vaultId: string;
  credentialId: string;
  force?: boolean;
  /** Auth material rejected by the caller; scopes the forced-admission floor. */
  expectedAuthVersion?: number;
}

export interface RefreshCredentialState {
  workspaceId: WorkspaceId;
  vaultId: string;
  credentialId: string;
  authVersion: number;
  mcpServerUrl: string;
  expiresAt?: string;
  refreshStatus: VaultOauthRefreshState["refreshStatus"];
  refreshAttempts: number;
  nextRefreshAt: string | null;
  authHintAt: string | null;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  hasClientSecret: boolean;
}

export type RefreshCredentialResult =
  | {
      outcome: "ok";
      state: RefreshCredentialState;
      persisted: PersistOauthRefreshResult["status"];
    }
  | {
      outcome: "invalid";
      reason: string;
      state: RefreshCredentialState | undefined;
      persisted: PersistOauthRefreshResult["status"];
    }
  | {
      outcome: "transient_error";
      reason: string;
      state: RefreshCredentialState | undefined;
      persisted: PersistOauthRefreshResult["status"];
    }
  | {
      outcome: "skipped";
      reason:
        | "missing"
        | "unsupported_credential_type"
        | "invalid_status"
        | "no_refresh_metadata"
        | "no_refresh_token"
        | "missing_client_secret"
        | "forced_refresh_floor";
      state: RefreshCredentialState | undefined;
    };

interface TokenRefreshSuccess {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string | null;
  scope?: string | null;
}

interface TokenRefreshFailure {
  outcome: "invalid" | "transient_error";
  reason: string;
  retryAfterMs?: number;
}

export class RefreshCoordinator {
  private readonly inflight = new Map<string, Promise<RefreshCredentialResult>>();
  private readonly forcedAdmissions = new Map<string, number>();
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly random: () => number;

  constructor(private readonly opts: RefreshCoordinatorOptions) {
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.timeoutMs = opts.timeoutMs ?? OAUTH_REFRESH_TIMEOUT_MS;
    this.maxBodyBytes = opts.maxBodyBytes ?? OAUTH_REFRESH_MAX_BODY_BYTES;
    this.random = opts.random ?? Math.random;
  }

  refreshCredential(input: RefreshCredentialInput): Promise<RefreshCredentialResult> {
    const key = `${input.workspaceId}\0${input.vaultId}\0${input.credentialId}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    if (input.force === true) {
      const admittedAt = this.now().getTime();
      for (const [admissionKey, timestamp] of this.forcedAdmissions) {
        if (admittedAt - timestamp >= OAUTH_FORCED_REFRESH_FLOOR_MS) {
          this.forcedAdmissions.delete(admissionKey);
        }
      }
      const forcedKey = `${key}\0${input.expectedAuthVersion ?? "unversioned"}`;
      const previousAdmission = this.forcedAdmissions.get(forcedKey);
      if (
        previousAdmission !== undefined &&
        admittedAt - previousAdmission < OAUTH_FORCED_REFRESH_FLOOR_MS
      ) {
        return Promise.resolve({
          outcome: "skipped",
          reason: "forced_refresh_floor",
          state: undefined,
        });
      }
      this.forcedAdmissions.set(forcedKey, admittedAt);
    }
    const promise = this.refreshCredentialOnce(input).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  recordAuthHint(input: PersistAuthHintInput): PersistAuthHintResult {
    return this.opts.store.persistAuthHint(input);
  }

  private async refreshCredentialOnce(
    input: RefreshCredentialInput,
  ): Promise<RefreshCredentialResult> {
    const state = this.opts.store.readOauthRefreshState(
      input.workspaceId,
      input.vaultId,
      input.credentialId,
    );
    if (state === undefined) {
      const row = this.opts.store.retrieveCredential(
        input.workspaceId,
        input.vaultId,
        input.credentialId,
      );
      if (row?.auth.type === "static_bearer") {
        return {
          outcome: "skipped",
          reason: "unsupported_credential_type",
          state: undefined,
        };
      }
      return { outcome: "skipped", reason: "missing", state };
    }
    if (state.refreshStatus === "invalid" && input.force !== true) {
      return {
        outcome: "skipped",
        reason: "invalid_status",
        state: publicState(state),
      };
    }
    if (state.refresh === undefined) {
      return {
        outcome: "skipped",
        reason: "no_refresh_metadata",
        state: publicState(state),
      };
    }
    if (state.secrets.refreshToken === undefined) {
      return {
        outcome: "skipped",
        reason: "no_refresh_token",
        state: publicState(state),
      };
    }
    if (
      state.refresh.tokenEndpointAuth.type !== "none" &&
      state.secrets.clientSecret === undefined
    ) {
      return {
        outcome: "skipped",
        reason: "missing_client_secret",
        state: publicState(state),
      };
    }

    const refreshed = await this.performTokenRefresh(state);
    if ("accessToken" in refreshed) {
      const now = this.now();
      const persisted = this.opts.store.persistOauthRefreshSuccess({
        workspaceId: input.workspaceId,
        vaultId: input.vaultId,
        credentialId: input.credentialId,
        expectedAuthVersion: state.authVersion,
        accessToken: refreshed.accessToken,
        ...(refreshed.refreshToken === undefined
          ? {}
          : { refreshToken: refreshed.refreshToken }),
        expiresAt: refreshed.expiresAt,
        ...(refreshed.scope === undefined ? {} : { scope: refreshed.scope }),
        nextRefreshAt:
          refreshed.expiresAt === null
            ? new Date(
                now.getTime() + OAUTH_REFRESH_LONG_LIVED_RECHECK_MS,
              ).toISOString()
            : nextRefreshAt(now, new Date(refreshed.expiresAt)).toISOString(),
        updatedAt: now.toISOString(),
      });
      return {
        outcome: "ok",
        state: publicState(persisted.state ?? state),
        persisted: persisted.status,
      };
    }

    const attempts = state.refreshAttempts + 1;
    const now = this.now();
    const status = refreshed.outcome === "invalid" ? "invalid" : "transient";
    const persisted = this.opts.store.persistOauthRefreshFailure({
      workspaceId: input.workspaceId,
      vaultId: input.vaultId,
      credentialId: input.credentialId,
      expectedAuthVersion: state.authVersion,
      status,
      refreshAttempts: attempts,
      nextRefreshAt:
        status === "invalid"
          ? null
          : new Date(
              now.getTime() +
                (refreshed.retryAfterMs ?? transientBackoffMs(attempts, this.random())),
            ).toISOString(),
    });
    return {
      outcome: refreshed.outcome,
      reason: refreshed.reason,
      state: persisted.state === undefined ? undefined : publicState(persisted.state),
      persisted: persisted.status,
    };
  }

  private async performTokenRefresh(
    state: VaultOauthRefreshState,
  ): Promise<TokenRefreshSuccess | TokenRefreshFailure> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init = buildRefreshRequest(state, controller.signal);
      const response = await this.fetchImpl(state.refresh!.tokenEndpoint, init);
      const body = await readLimitedText(response, this.maxBodyBytes);
      const parsed = parseJsonObject(body);
      if (!parsed.ok) {
        return {
          outcome: "transient_error",
          reason: parsed.reason,
          retryAfterMs: retryAfterMs(response),
        };
      }
      return classifyTokenResponse(response, parsed.value, this.now());
    } catch (error) {
      if (isAbortError(error)) {
        return { outcome: "transient_error", reason: "timeout" };
      }
      if (error instanceof ResponseBodyTooLargeError) {
        return { outcome: "transient_error", reason: "response_body_too_large" };
      }
      return {
        outcome: "transient_error",
        reason: isRedirectError(error) ? "redirect_blocked" : "request_failed",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function nextRefreshAt(now: Date, expiresAt: Date): Date {
  const ttlMs = expiresAt.getTime() - now.getTime();
  if (ttlMs <= 0) return new Date(now.getTime() + OAUTH_REFRESH_FLOOR_MS);
  if (ttlMs < OAUTH_REFRESH_LEAD_MS) {
    return new Date(
      now.getTime() + Math.max(OAUTH_REFRESH_FLOOR_MS, Math.floor(ttlMs / 2)),
    );
  }
  return new Date(expiresAt.getTime() - OAUTH_REFRESH_LEAD_MS);
}

function transientBackoffMs(attempts: number, random: number): number {
  const base = Math.min(
    OAUTH_REFRESH_MAX_BACKOFF_MS,
    60_000 * 2 ** Math.max(0, attempts - 1),
  );
  const jitter = 0.9 + Math.min(1, Math.max(0, random)) * 0.2;
  return Math.min(OAUTH_REFRESH_MAX_BACKOFF_MS, Math.round(base * jitter));
}

function buildRefreshRequest(state: VaultOauthRefreshState, signal: AbortSignal): RequestInit {
  const refresh = state.refresh!;
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", state.secrets.refreshToken!);
  if (refresh.scope !== undefined) body.set("scope", refresh.scope);
  const headers = new Headers();
  headers.set("content-type", "application/x-www-form-urlencoded");
  const mode = refresh.tokenEndpointAuth.type;
  if (mode === "none") {
    body.set("client_id", refresh.clientId);
  } else if (mode === "client_secret_post") {
    body.set("client_id", refresh.clientId);
    body.set("client_secret", state.secrets.clientSecret!);
  } else {
    headers.set(
      "authorization",
      `Basic ${Buffer.from(
        `${formEncodeComponent(refresh.clientId)}:${formEncodeComponent(
          state.secrets.clientSecret!,
        )}`,
      ).toString("base64")}`,
    );
  }
  return {
    method: "POST",
    redirect: "error",
    headers,
    body,
    signal,
  };
}

function formEncodeComponent(value: string): string {
  const params = new URLSearchParams();
  params.set("x", value);
  return params.toString().slice(2);
}

function classifyTokenResponse(
  response: Response,
  value: Record<string, unknown>,
  now: Date,
): TokenRefreshSuccess | TokenRefreshFailure {
  const oauthError = oauthErrorCode(value);
  if (!response.ok || oauthError !== undefined) {
    return {
      outcome: oauthError !== undefined && PERMANENT_OAUTH_ERRORS.has(oauthError)
        ? "invalid"
        : "transient_error",
      reason: oauthError ?? `http_${response.status}`,
      retryAfterMs: retryAfterMs(response, now.getTime()),
    };
  }
  if (
    value.ok === false &&
    typeof value.error === "string" &&
    value.error.length > 0
  ) {
    const error = value.error;
    return {
      outcome: PERMANENT_OAUTH_ERRORS.has(error) ? "invalid" : "transient_error",
      reason: error,
      retryAfterMs: retryAfterMs(response, now.getTime()),
    };
  }
  if (typeof value.access_token !== "string" || value.access_token.length === 0) {
    return { outcome: "transient_error", reason: "missing_access_token" };
  }
  if (
    typeof value.token_type === "string" &&
    value.token_type.toLowerCase() !== "bearer"
  ) {
    return { outcome: "invalid", reason: "unsupported_token_type" };
  }
  const expiresAt = expiresAtFromResponse(value, now);
  return {
    accessToken: value.access_token,
    ...(typeof value.refresh_token === "string" && value.refresh_token.length > 0
      ? { refreshToken: value.refresh_token }
      : {}),
    expiresAt,
    ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
  };
}

function oauthErrorCode(value: Record<string, unknown>): string | undefined {
  return typeof value.error === "string" && value.error.length > 0
    ? value.error
    : undefined;
}

function expiresAtFromResponse(
  value: Record<string, unknown>,
  now: Date,
): string | null {
  if (typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in)) {
    return null;
  }
  return new Date(now.getTime() + Math.max(0, value.expires_in) * 1000).toISOString();
}

function retryAfterMs(response: Response, now = Date.now()): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(OAUTH_REFRESH_MAX_BACKOFF_MS, seconds * 1000);
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.min(
    OAUTH_REFRESH_MAX_BACKOFF_MS,
    Math.max(0, date - now),
  );
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("json")) {
    return "";
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) throw new ResponseBodyTooLargeError();
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseJsonObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  if (text.length === 0) return { ok: false, reason: "non_json_response" };
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? { ok: true, value: parsed as Record<string, unknown> }
      : { ok: false, reason: "invalid_json_response" };
  } catch {
    return { ok: false, reason: "invalid_json_response" };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRedirectError(error: unknown): boolean {
  let current: unknown = error;
  for (let i = 0; i < 4 && current !== undefined; i++) {
    if (
      current instanceof Error &&
      /redirect/i.test(`${current.name} ${current.message}`)
    ) {
      return true;
    }
    current = typeof current === "object" && current !== null && "cause" in current
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  return false;
}

function publicState(state: VaultOauthRefreshState): RefreshCredentialState {
  return {
    workspaceId: state.workspaceId,
    vaultId: state.vaultId,
    credentialId: state.credentialId,
    authVersion: state.authVersion,
    mcpServerUrl: state.mcpServerUrl,
    ...(state.expiresAt === undefined ? {} : { expiresAt: state.expiresAt }),
    refreshStatus: state.refreshStatus,
    refreshAttempts: state.refreshAttempts,
    nextRefreshAt: state.nextRefreshAt,
    authHintAt: state.authHintAt,
    hasAccessToken: state.secrets.accessToken !== undefined,
    hasRefreshToken: state.secrets.refreshToken !== undefined,
    hasClientSecret: state.secrets.clientSecret !== undefined,
  };
}

class ResponseBodyTooLargeError extends Error {}
