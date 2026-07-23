import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  auth,
  selectClientAuthMethod,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { invalidRequest, notFound } from "../errors.ts";
import type { McpFetch } from "../sessions/pi/mcp/fetch.ts";
import type { WorkspaceId } from "../workspace.ts";
import type { ManagedVaultCredential, VaultService } from "./types.ts";

export const CONSOLE_MCP_OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;
export const CONSOLE_MCP_OAUTH_MAX_BODY_BYTES = 64 * 1024;

type FlowOperation = "connect" | "reauthorize";
type FlowState = "pending" | "completing" | "connected" | "failed" | "expired";

interface OAuthFlow {
  id: string;
  state: string;
  workspaceId: WorkspaceId;
  vaultId: string;
  credentialId?: string;
  displayName?: string;
  serverUrl: string;
  redirectUrl: string;
  operation: FlowOperation;
  createdAtMs: number;
  expiresAtMs: number;
  status: FlowState;
  provider: FlowProvider;
  credential?: ManagedVaultCredential;
  error?: ConsoleMcpOauthError;
}

export interface ConsoleMcpOauthFlowStart {
  flow_id: string;
  authorization_url: string;
  expires_at: string;
}

export interface ConsoleMcpOauthFlowStatus {
  flow_id: string;
  status: FlowState;
  expires_at: string;
  credential_id?: string;
  refreshable?: boolean;
  error?: ConsoleMcpOauthError;
}

export interface ConsoleMcpOauthCallbackResult {
  flowId: string;
  ok: boolean;
}

export interface ConsoleMcpOauthError {
  code:
    | "authorization_denied"
    | "callback_invalid"
    | "callback_expired"
    | "provider_unsupported"
    | "provider_unreachable"
    | "token_exchange_failed"
    | "credential_persist_failed";
  message: string;
}

export class ConsoleMcpOauthService {
  private readonly flows = new Map<string, OAuthFlow>();
  private readonly flowIdsByState = new Map<string, string>();

  constructor(
    private readonly vaults: VaultService,
    private readonly fetch: McpFetch,
    private readonly opts: {
      now?: () => Date;
      flowTtlMs?: number;
      operationTimeoutMs?: number;
      maxBodyBytes?: number;
    } = {},
  ) {}

  async startConnect(
    workspaceId: WorkspaceId,
    input: unknown,
    callbackUrl: string,
  ): Promise<ConsoleMcpOauthFlowStart> {
    const body = objectInput(input);
    const vaultId = stringField(body, "vault_id");
    const serverUrl = mcpServerUrl(stringField(body, "mcp_server_url"));
    const displayName = optionalStringField(body, "display_name");
    this.vaults.retrieveVault(workspaceId, vaultId);
    return this.start({
      workspaceId,
      vaultId,
      ...(displayName === undefined ? {} : { displayName }),
      serverUrl,
      callbackUrl,
      operation: "connect",
    });
  }

  async startReauthorize(
    workspaceId: WorkspaceId,
    input: unknown,
    callbackUrl: string,
  ): Promise<ConsoleMcpOauthFlowStart> {
    const body = objectInput(input);
    const vaultId = stringField(body, "vault_id");
    const credentialId = stringField(body, "credential_id");
    const credential = this.vaults.retrieveCredential(
      workspaceId,
      vaultId,
      credentialId,
    );
    if (credential.archived_at !== null) throw invalidRequest("Credential is archived.");
    if (credential.auth.type !== "mcp_oauth") {
      throw invalidRequest("Only MCP OAuth credentials can be reauthorized");
    }
    const oauth = this.vaults.readOauthValidationSnapshot(
      workspaceId,
      vaultId,
      credentialId,
    );
    if (oauth?.refresh === undefined) {
      throw invalidRequest("This OAuth credential has no reusable client registration");
    }
    return this.start({
      workspaceId,
      vaultId,
      credentialId,
      serverUrl: credential.auth.mcp_server_url,
      callbackUrl,
      operation: "reauthorize",
      clientInformation: {
        client_id: oauth.refresh.clientId,
        ...(oauth.secrets.clientSecret === undefined
          ? {}
          : { client_secret: oauth.secrets.clientSecret }),
      },
    });
  }

  status(workspaceId: WorkspaceId, flowId: string): ConsoleMcpOauthFlowStatus {
    const flow = this.flowForWorkspace(workspaceId, flowId);
    this.expire(flow);
    return publicStatus(flow);
  }

  deny(state: string | undefined): ConsoleMcpOauthCallbackResult {
    const flow = this.consumeCallbackState(state);
    flow.status = "failed";
    flow.error = {
      code: "authorization_denied",
      message: "Authorization was denied or cancelled at the provider.",
    };
    flow.provider.clearSecrets();
    return { flowId: flow.id, ok: false };
  }

  async complete(
    state: string | undefined,
    code: string | undefined,
  ): Promise<ConsoleMcpOauthCallbackResult> {
    const flow = this.consumeCallbackState(state);
    if (!code) {
      flow.status = "failed";
      flow.error = {
        code: "callback_invalid",
        message: "The provider callback did not include an authorization code.",
      };
      return { flowId: flow.id, ok: false };
    }
    flow.status = "completing";
    let safetyFailure: ConsoleMcpOauthError | undefined;
    try {
      const result = await auth(flow.provider, {
        serverUrl: flow.serverUrl,
        authorizationCode: code,
        fetchFn: this.oauthFetch((error) => { safetyFailure = error; }),
      });
      if (result !== "AUTHORIZED" || flow.provider.savedTokens === undefined) {
        throw new Error("OAuth token exchange did not produce tokens");
      }
      flow.credential = this.persist(flow, flow.provider.savedTokens);
      flow.status = "connected";
    } catch (error) {
      flow.status = "failed";
      flow.error = safetyFailure ?? classifyOauthError(error, "token_exchange_failed");
    } finally {
      flow.provider.clearSecrets();
    }
    return { flowId: flow.id, ok: flow.status === "connected" };
  }

  private async start(input: {
    workspaceId: WorkspaceId;
    vaultId: string;
    credentialId?: string;
    displayName?: string;
    serverUrl: string;
    callbackUrl: string;
    operation: FlowOperation;
    clientInformation?: OAuthClientInformationMixed;
  }): Promise<ConsoleMcpOauthFlowStart> {
    this.cleanup();
    const now = this.now();
    const flowId = opaqueId("oauth_flow");
    const state = opaqueId("oauth_state");
    const provider = new FlowProvider({
      redirectUrl: input.callbackUrl,
      state,
      clientInformation: input.clientInformation,
    });
    const flow: OAuthFlow = {
      id: flowId,
      state,
      workspaceId: input.workspaceId,
      vaultId: input.vaultId,
      ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      serverUrl: input.serverUrl,
      redirectUrl: input.callbackUrl,
      operation: input.operation,
      createdAtMs: now.getTime(),
      expiresAtMs: now.getTime() + (this.opts.flowTtlMs ?? CONSOLE_MCP_OAUTH_FLOW_TTL_MS),
      status: "pending",
      provider,
    };
    this.flows.set(flowId, flow);
    this.flowIdsByState.set(state, flowId);
    let safetyFailure: ConsoleMcpOauthError | undefined;
    try {
      const result = await auth(provider, {
        serverUrl: input.serverUrl,
        fetchFn: this.oauthFetch((error) => { safetyFailure = error; }),
      });
      if (result !== "REDIRECT" || provider.authorizationUrl === undefined) {
        throw new Error("OAuth provider did not return an authorization redirect");
      }
      return {
        flow_id: flow.id,
        authorization_url: provider.authorizationUrl.toString(),
        expires_at: new Date(flow.expiresAtMs).toISOString(),
      };
    } catch (error) {
      this.flowIdsByState.delete(state);
      provider.clearSecrets();
      flow.status = "failed";
      flow.error = safetyFailure ?? classifyOauthError(error, "provider_unsupported");
      throw invalidRequest(flow.error.message);
    }
  }

  private oauthFetch(onSafetyFailure: (error: ConsoleMcpOauthError) => void): McpFetch {
    return boundedOauthFetch(
      this.fetch,
      {
        timeoutMs: this.opts.operationTimeoutMs ?? 30_000,
        maxBodyBytes: this.opts.maxBodyBytes ?? CONSOLE_MCP_OAUTH_MAX_BODY_BYTES,
      },
      onSafetyFailure,
    );
  }

  private persist(flow: OAuthFlow, tokens: OAuthTokens): ManagedVaultCredential {
    const client = flow.provider.savedClientInformation;
    const discovery = flow.provider.savedDiscoveryState;
    const tokenEndpoint = discovery?.authorizationServerMetadata?.token_endpoint;
    const refreshToken = tokens.refresh_token;
    const clientId = client?.client_id;
    const expiresAt = tokens.expires_in === undefined
      ? undefined
      : new Date(this.now().getTime() + tokens.expires_in * 1000).toISOString();

    try {
      if (flow.operation === "reauthorize") {
        return this.vaults.updateCredential(
          flow.workspaceId,
          flow.vaultId,
          flow.credentialId!,
          {
            auth: {
              type: "mcp_oauth",
              access_token: tokens.access_token,
              expires_at: expiresAt ?? null,
              ...(refreshToken === undefined
                ? {}
                : { refresh: { refresh_token: refreshToken } }),
            },
          },
        );
      }
      const canRefresh = refreshToken !== undefined && clientId !== undefined && tokenEndpoint !== undefined;
      const authType = client === undefined
        ? "none"
        : selectClientAuthMethod(
            client,
            discovery?.authorizationServerMetadata?.token_endpoint_auth_methods_supported ?? [],
          );
      return this.vaults.createCredential(flow.workspaceId, flow.vaultId, {
        ...(flow.displayName === undefined ? {} : { display_name: flow.displayName }),
        auth: {
          type: "mcp_oauth",
          mcp_server_url: flow.serverUrl,
          access_token: tokens.access_token,
          ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
          ...(canRefresh
            ? {
                refresh: {
                  token_endpoint: tokenEndpoint,
                  client_id: clientId,
                  ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
                  refresh_token: refreshToken,
                  token_endpoint_auth: {
                    type: authType,
                    ...(client?.client_secret === undefined
                      ? {}
                      : { client_secret: client.client_secret }),
                  },
                },
              }
            : {}),
        },
      });
    } catch (error) {
      throw Object.assign(new Error("OAuth completed, but OMA could not save the credential"), {
        cause: error,
        oauthPersistenceFailure: true,
      });
    }
  }

  private consumeCallbackState(state: string | undefined): OAuthFlow {
    if (!state) throw invalidRequest("The OAuth callback state is missing");
    const flowId = this.flowIdsByState.get(state);
    if (flowId === undefined) throw invalidRequest("The OAuth callback is unknown or was already used");
    const flow = this.flows.get(flowId);
    if (flow === undefined || !safeEqual(state, flow.state)) {
      throw invalidRequest("The OAuth callback is unknown or was already used");
    }
    this.flowIdsByState.delete(state);
    if (this.expire(flow)) {
      flow.error = {
        code: "callback_expired",
        message: "The OAuth connection expired. Start Connect again.",
      };
      throw invalidRequest(flow.error.message);
    }
    if (flow.status !== "pending") {
      throw invalidRequest("The OAuth callback is unknown or was already used");
    }
    return flow;
  }

  private flowForWorkspace(workspaceId: WorkspaceId, flowId: string): OAuthFlow {
    const flow = this.flows.get(flowId);
    if (flow === undefined || flow.workspaceId !== workspaceId) {
      throw notFound(`OAuth flow ${flowId} not found`);
    }
    return flow;
  }

  private expire(flow: OAuthFlow): boolean {
    if (flow.status === "pending" && this.now().getTime() >= flow.expiresAtMs) {
      this.flowIdsByState.delete(flow.state);
      flow.provider.clearSecrets();
      flow.status = "expired";
      flow.error = {
        code: "callback_expired",
        message: "The OAuth connection expired. Start Connect again.",
      };
      return true;
    }
    return flow.status === "expired";
  }

  private cleanup(): void {
    const cutoff = this.now().getTime() - (this.opts.flowTtlMs ?? CONSOLE_MCP_OAUTH_FLOW_TTL_MS);
    for (const [id, flow] of this.flows) {
      this.expire(flow);
      if (flow.expiresAtMs < cutoff) this.flows.delete(id);
    }
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }
}

class FlowProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  savedClientInformation?: OAuthClientInformationMixed;
  savedTokens?: OAuthTokens;
  savedCodeVerifier?: string;
  savedDiscoveryState?: OAuthDiscoveryState;

  readonly clientMetadata: OAuthClientMetadata;

  constructor(private readonly input: {
    redirectUrl: string;
    state: string;
    clientInformation?: OAuthClientInformationMixed;
  }) {
    this.savedClientInformation = input.clientInformation;
    this.clientMetadata = {
      redirect_uris: [input.redirectUrl],
      client_name: "Open Managed Agents",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  get redirectUrl(): string {
    return this.input.redirectUrl;
  }

  state(): string {
    return this.input.state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.savedClientInformation;
  }

  saveClientInformation(value: OAuthClientInformationMixed): void {
    this.savedClientInformation = value;
  }

  tokens(): OAuthTokens | undefined {
    return undefined;
  }

  saveTokens(value: OAuthTokens): void {
    this.savedTokens = value;
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(value: string): void {
    this.savedCodeVerifier = value;
  }

  codeVerifier(): string {
    if (this.savedCodeVerifier === undefined) throw new Error("PKCE verifier is missing");
    return this.savedCodeVerifier;
  }

  saveDiscoveryState(value: OAuthDiscoveryState): void {
    this.savedDiscoveryState = value;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.savedDiscoveryState;
  }

  clearSecrets(): void {
    this.savedTokens = undefined;
    this.savedCodeVerifier = undefined;
    if (this.savedClientInformation?.client_secret !== undefined) {
      const { client_secret: _discarded, ...clientInformation } = this.savedClientInformation;
      this.savedClientInformation = clientInformation;
    }
  }
}

function publicStatus(flow: OAuthFlow): ConsoleMcpOauthFlowStatus {
  const oauth = flow.credential?.auth.type === "mcp_oauth" ? flow.credential.auth : undefined;
  return {
    flow_id: flow.id,
    status: flow.status,
    expires_at: new Date(flow.expiresAtMs).toISOString(),
    ...(flow.credential === undefined ? {} : { credential_id: flow.credential.id }),
    ...(oauth === undefined ? {} : { refreshable: oauth.refresh !== undefined }),
    ...(flow.error === undefined ? {} : { error: flow.error }),
  };
}

function classifyOauthError(
  error: unknown,
  fallback: ConsoleMcpOauthError["code"],
): ConsoleMcpOauthError {
  if (isObject(error) && error.oauthPersistenceFailure === true) {
    return {
      code: "credential_persist_failed",
      message: "Authorization succeeded, but OMA could not save the credential.",
    };
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (
    message.includes("registration endpoint") ||
    message.includes("client information") ||
    message.includes("dynamic client registration")
  ) {
    return {
      code: "provider_unsupported",
      message: "This MCP provider does not support automatic client registration. A pre-registered client is not supported in this console flow yet.",
    };
  }
  if (
    message.includes("fetch failed") ||
    message.includes("timeout") ||
    message.includes("aborted") ||
    message.includes("egress denied") ||
    message.includes("response too large")
  ) {
    return {
      code: "provider_unreachable",
      message: "OMA could not safely reach the MCP authorization service.",
    };
  }
  return fallback === "provider_unsupported"
    ? {
        code: fallback,
        message: "This MCP server did not expose a supported OAuth authorization flow.",
      }
    : {
        code: fallback,
        message: "The provider could not complete the OAuth token exchange. Start Connect again.",
      };
}

function boundedOauthFetch(
  inner: McpFetch,
  opts: { timeoutMs: number; maxBodyBytes: number },
  onSafetyFailure: (error: ConsoleMcpOauthError) => void,
): McpFetch {
  return async (url, init = {}) => {
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      onSafetyFailure(oauthFetchSafetyFailure());
      timeout.abort();
    }, opts.timeoutMs);
    const signal = init.signal == null
      ? timeout.signal
      : AbortSignal.any([init.signal, timeout.signal]);
    try {
      const response = await inner(url, { ...init, signal });
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > opts.maxBodyBytes) {
        await response.body?.cancel();
        onSafetyFailure(oauthFetchSafetyFailure());
        throw new Error("OAuth response too large");
      }
      let bytes: Uint8Array;
      try {
        bytes = await readBoundedBody(response, opts.maxBodyBytes);
      } catch (error) {
        if (error instanceof Error && error.message === "OAuth response too large") {
          onSafetyFailure(oauthFetchSafetyFailure());
        }
        throw error;
      }
      return new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

function oauthFetchSafetyFailure(): ConsoleMcpOauthError {
  return {
    code: "provider_unreachable",
    message: "OMA could not safely reach the MCP authorization service.",
  };
}

async function readBoundedBody(response: Response, maxBodyBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) throw new Error("OAuth response too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function mcpServerUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    if (url.username || url.password || url.hash) throw new Error();
    return url.toString();
  } catch {
    throw invalidRequest("`mcp_server_url` must be an http(s) URL without userinfo or a fragment");
  }
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!isObject(input)) throw invalidRequest("Request body must be a JSON object");
  return input;
}

function stringField(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidRequest(`\`${field}\` must be a non-empty string`);
  }
  return value.trim();
}

function optionalStringField(
  input: Record<string, unknown>,
  field: string,
): string | undefined {
  if (input[field] === undefined) return undefined;
  return stringField(input, field);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
