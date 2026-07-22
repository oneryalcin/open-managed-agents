// api.js — OMA REST adapter for the static Managed Agents Console.
// ES module (plan 0120 §3.3): loaded with type="module" in index.html so the
// pure header logic below is importable by Node tests without a browser.
import { followEventStream } from "./sse.js";

const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
const FILES_API_BETA = "files-api-2025-04-14";
const SKILLS_API_BETA = "skills-2025-10-02";
const BETA_HEADER = `${MANAGED_AGENTS_BETA}, ${FILES_API_BETA}, ${SKILLS_API_BETA}`;
const PAGE_LIMIT = 100;
const EVENT_PAGE_LIMIT = 1000;
const MAX_AUTO_PAGES = 100;
const VALIDATE_CAPABILITY = Symbol("validate-mcp-oauth-credential");
const VALIDATE_ENVIRONMENT_NETWORKING_CAPABILITY = Symbol("validate-environment-networking");
const CREATE_AGENT_CAPABILITY = Symbol("create-agent");
const CREATE_ENVIRONMENT_CAPABILITY = Symbol("create-environment");
const ARCHIVE_ENVIRONMENT_CAPABILITY = Symbol("archive-environment");
const DELETE_ENVIRONMENT_CAPABILITY = Symbol("delete-environment");
const CREATE_SESSION_CAPABILITY = Symbol("create-session");
const SEND_SESSION_EVENTS_CAPABILITY = Symbol("send-session-events");
const ARCHIVE_AGENT_CAPABILITY = Symbol("archive-agent");
const UPDATE_AGENT_CAPABILITY = Symbol("update-agent");
const ARCHIVE_SESSION_CAPABILITY = Symbol("archive-session");
const DELETE_SESSION_CAPABILITY = Symbol("delete-session");
const CREATE_VAULT_CAPABILITY = Symbol("create-vault");
const CREATE_VAULT_CREDENTIAL_CAPABILITY = Symbol("create-vault-credential");
const CREATE_SKILL_CAPABILITY = Symbol("create-skill");
const CMA_BUILTIN_TOOL_NAMES = [
  "bash",
  "edit",
  "glob",
  "grep",
  "read",
  "web_fetch",
  "web_search",
  "write",
];

// Legacy direct-header credentials remain available for interactive API tests,
// but the console UI never sets them. Browser logins exchange a pasted key for
// an opaque HttpOnly session cookie, which JavaScript cannot read or persist.
const credentials = {
  adminKey: null,
  workspaceKey: null,
};

export function setAdminKey(key) {
  credentials.adminKey = key || null;
}

export function setWorkspaceKey(key) {
  credentials.workspaceKey = key || null;
}

export function clearCredentials() {
  credentials.adminKey = null;
  credentials.workspaceKey = null;
}

export function hasWorkspaceKey() {
  return credentials.workspaceKey !== null;
}

export function canSubmitToolConfirmation({ status, readOnly, actionBusy }) {
  return status !== "archived" && !readOnly && !actionBusy;
}

// Pure: (path, creds) -> headers. Exported for unit tests — this routing is
// the guarantee that the admin key never rides a /v1 request and the
// workspace key never rides an /admin one.
export function buildRequestHeaders(path, creds) {
  const headers = { accept: "application/json" };
  if (path === "/admin" || path.startsWith("/admin/")) {
    if (creds.adminKey) headers["x-admin-key"] = creds.adminKey;
  } else if (path.startsWith("/v1/")) {
    headers["anthropic-beta"] = BETA_HEADER;
    if (creds.workspaceKey) headers["x-api-key"] = creds.workspaceKey;
  }
  return headers;
}

// A 401 means the key for that tier is wrong or revoked; keeping it would
// just replay the failure, so drop it and let the UI re-prompt.
export function clearKeyForPath(path, creds) {
  if (path === "/admin" || path.startsWith("/admin/")) {
    creds.adminKey = null;
  } else if (path.startsWith("/v1/")) {
    creds.workspaceKey = null;
  }
}

function isExactValidatePath(path) {
  const pathname = new URL(path, "http://oma.local").pathname;
  return /^\/v1\/vaults\/[^/]+\/credentials\/[^/]+\/mcp_oauth_validate$/.test(pathname);
}

function isExactEnvironmentNetworkingValidatePath(path) {
  const pathname = new URL(path, "http://oma.local").pathname;
  return pathname === "/v1/environments/networking-presets/validate";
}

async function request(path, { method = "GET", body, form, capability, headers: extraHeaders } = {}) {
  // Normalize the verb once so the guard and fetch see the same value. The
  // guard is already fail-closed for any casing (a lowercase "post" is
  // non-GET, so it is denied unless it exactly matches the capability clause);
  // normalizing just keeps the capability path from rejecting a well-intentioned
  // lowercase caller and avoids case being load-bearing here.
  const normalizedMethod = String(method).toUpperCase();
  // Keep /v1 writes deny-by-default. New workspace-key writes need a narrowly
  // named capability rather than silently gaining access through this generic
  // transport helper.
  if (normalizedMethod !== "GET" && path.startsWith("/v1/") &&
      !isAllowedWorkspaceWrite(path, normalizedMethod, capability)) {
    throw new Error("Console /v1 writes are not permitted");
  }
  const headers = buildRequestHeaders(path, credentials);
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const init = { method: normalizedMethod, headers, credentials: "same-origin" };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  if (form !== undefined) init.body = form;
  const response = await fetch(path, init);
  const text = await response.text();
  // A fronting proxy (TLS terminator, LB) can answer 502/504 with HTML; that
  // must surface as "Request failed (5xx)", not a JSON.parse SyntaxError.
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    if (response.status === 401) clearKeyForPath(path, credentials);
    const message = parsed?.error?.message ?? `Request failed (${response.status})`;
    const error = new Error(message);
    error.response = parsed;
    error.status = response.status;
    throw error;
  }
  return parsed;
}

function isAllowedWorkspaceWrite(path, method, capability) {
  return (
    (capability === VALIDATE_CAPABILITY && method === "POST" && isExactValidatePath(path)) ||
    (capability === VALIDATE_ENVIRONMENT_NETWORKING_CAPABILITY && method === "POST" && isExactEnvironmentNetworkingValidatePath(path)) ||
    (capability === CREATE_AGENT_CAPABILITY && method === "POST" && path === "/v1/agents") ||
    (capability === CREATE_ENVIRONMENT_CAPABILITY && method === "POST" && path === "/v1/environments") ||
    (
      capability === ARCHIVE_ENVIRONMENT_CAPABILITY &&
      method === "POST" &&
      /^\/v1\/environments\/[^/]+\/archive$/.test(new URL(path, "http://oma.local").pathname)
    ) ||
    (
      capability === DELETE_ENVIRONMENT_CAPABILITY &&
      method === "DELETE" &&
      /^\/v1\/environments\/[^/]+$/.test(new URL(path, "http://oma.local").pathname)
    ) ||
    (capability === CREATE_SESSION_CAPABILITY && method === "POST" && path === "/v1/sessions") ||
    (capability === CREATE_VAULT_CAPABILITY && method === "POST" && path === "/v1/vaults") ||
    (
      capability === CREATE_VAULT_CREDENTIAL_CAPABILITY &&
      method === "POST" &&
      /^\/v1\/vaults\/[^/]+\/credentials$/.test(new URL(path, "http://oma.local").pathname)
    ) ||
    (capability === CREATE_SKILL_CAPABILITY && method === "POST" && path === "/v1/skills") ||
    (
      capability === ARCHIVE_AGENT_CAPABILITY &&
      method === "POST" &&
      /^\/v1\/agents\/[^/]+\/archive$/.test(new URL(path, "http://oma.local").pathname)
    ) ||
    (
      capability === UPDATE_AGENT_CAPABILITY &&
      method === "POST" &&
      /^\/v1\/agents\/[^/]+$/.test(new URL(path, "http://oma.local").pathname)
    ) ||
    (
      capability === ARCHIVE_SESSION_CAPABILITY &&
      method === "POST" &&
      /^\/v1\/sessions\/[^/]+\/archive$/.test(new URL(path, "http://oma.local").pathname)
    ) ||
    (
      capability === DELETE_SESSION_CAPABILITY &&
      method === "DELETE" &&
      /^\/v1\/sessions\/[^/]+$/.test(new URL(path, "http://oma.local").pathname)
    ) ||
    (
      capability === SEND_SESSION_EVENTS_CAPABILITY &&
      method === "POST" &&
      /^\/v1\/sessions\/[^/]+\/events$/.test(new URL(path, "http://oma.local").pathname)
    )
  );
}

// Deliberately not added to window.OmaConsoleApi: this exists solely for the
// Node contract tests that prove forbidden /v1 writes fail before fetch.
export const __testRequest = request;

const fetchJson = request;

// --- Admin API (0119 §4). Lists return bare arrays; mint returns the
// plaintext exactly once — render it, never store or log it.

export function createWorkspace(name) {
  return request("/admin/workspaces", { method: "POST", body: { name } });
}

export function listWorkspaces() {
  return request("/admin/workspaces");
}

// Minting is deduplicated while in flight: a double-click or nervous retry
// must not create a second active credential whose plaintext instantly
// replaces the first in the UI — the orphaned key would stay active with
// nobody holding its plaintext. Both clicks resolve to the same mint.
const mintsInFlight = new Map();

export function mintKey(workspaceId, label) {
  const pending = mintsInFlight.get(workspaceId);
  if (pending) return pending;
  const mint = request(`/admin/workspaces/${encodeURIComponent(workspaceId)}/keys`, {
    method: "POST",
    ...(label ? { body: { label } } : {}),
  }).finally(() => mintsInFlight.delete(workspaceId));
  mintsInFlight.set(workspaceId, mint);
  return mint;
}

export function listKeys(workspaceId) {
  return request(`/admin/workspaces/${encodeURIComponent(workspaceId)}/keys`);
}

export function revokeKey(keySha256) {
  return request(`/admin/keys/${encodeURIComponent(keySha256)}`, {
    method: "DELETE",
  });
}

export function listVaults() {
  return fetchCursorPages("/v1/vaults?include_archived=true");
}

export function listVaultCredentials(vaultId) {
  return fetchCursorPages(
    `/v1/vaults/${encodeURIComponent(vaultId)}/credentials?include_archived=true`,
  );
}

export function createVault(body) {
  return request("/v1/vaults", {
    method: "POST",
    body,
    capability: CREATE_VAULT_CAPABILITY,
  });
}

export function createVaultCredential(vaultId, body) {
  return request(`/v1/vaults/${encodeURIComponent(vaultId)}/credentials`, {
    method: "POST",
    body,
    capability: CREATE_VAULT_CREDENTIAL_CAPABILITY,
  });
}

export function listSkills() {
  return fetchCursorPages("/v1/skills");
}

export function createSkill(displayTitle, files) {
  const form = new FormData();
  if (displayTitle) form.set("display_title", displayTitle);
  for (const file of files) form.append("files[]", file, file.name);
  return request("/v1/skills", {
    method: "POST",
    form,
    capability: CREATE_SKILL_CAPABILITY,
  });
}

export function listWorkspaceCredentialHealth(workspaceId, page) {
  const url = new URL(
    `/admin/workspaces/${encodeURIComponent(workspaceId)}/mcp-credentials`,
    window.location.origin,
  );
  url.searchParams.set("limit", String(PAGE_LIMIT));
  if (page) url.searchParams.set("page", page);
  return request(url.pathname + url.search);
}

export function getConsoleAuthStatus() {
  return request("/console/auth/status");
}

export function loginConsoleWorkspace(apiKey) {
  return request("/console/auth/workspace", { method: "POST", body: { api_key: apiKey } });
}

export function consumeConsoleBootstrap(nonce) {
  return request("/console/auth/bootstrap", { method: "POST", body: { nonce } });
}

export function loginConsoleAdmin(adminKey) {
  return request("/console/auth/admin", { method: "POST", body: { admin_key: adminKey } });
}

export function selectConsoleWorkspace(workspaceId) {
  return request("/console/auth/select-workspace", { method: "POST", body: { workspace_id: workspaceId } });
}

export function logoutConsole() {
  return request("/console/auth/logout", { method: "POST" });
}

export function validateMcpOauthCredential(vaultId, credentialId, mode) {
  if (mode !== "api") return Promise.reject(new Error("Validate is only available in live API mode"));
  const path = `/v1/vaults/${encodeURIComponent(vaultId)}/credentials/${encodeURIComponent(credentialId)}/mcp_oauth_validate`;
  return request(path, { method: "POST", capability: VALIDATE_CAPABILITY });
}

export function createIdempotencyIntent() {
  return { key: null, fingerprint: null };
}

export function createAgent(body) {
  return request("/v1/agents", {
    method: "POST",
    body,
    capability: CREATE_AGENT_CAPABILITY,
  }).then(toUiAgent);
}

export function archiveAgent(agentId) {
  return request(`/v1/agents/${encodeURIComponent(agentId)}/archive`, {
    method: "POST",
    capability: ARCHIVE_AGENT_CAPABILITY,
  }).then(toUiAgent);
}

export function updateAgentToolPermission(agent, policy) {
  if (policy !== "always_allow" && policy !== "always_ask") {
    return Promise.reject(new Error("Unsupported tool permission policy"));
  }
  if (!Number.isSafeInteger(agent?.apiVersion) || !Array.isArray(agent?.rawTools)) {
    return Promise.reject(new Error("Agent configuration is incomplete; refresh before updating"));
  }
  let hasEnabledBuiltinTool = false;
  const tools = agent.rawTools.map((toolset) => {
    if (toolset?.type !== "agent_toolset_20260401") return toolset;
    const defaultEnabled = toolset.default_config?.enabled !== false;
    const configs = Array.isArray(toolset.configs) ? toolset.configs : [];
    hasEnabledBuiltinTool ||= effectiveBuiltinTools(toolset).some((tool) => tool.enabled);
    return {
      ...toolset,
      default_config: {
        ...(toolset.default_config ?? {}),
        permission_policy: { type:policy },
      },
      ...(Array.isArray(toolset.configs) ? {
        configs: configs.map((config) =>
          (config.enabled ?? defaultEnabled) === false
            ? config
            : { ...config, permission_policy:{ type:policy } }),
      } : {}),
    };
  });
  if (!hasEnabledBuiltinTool) {
    return Promise.reject(new Error("This agent has no enabled built-in tools to update"));
  }
  return request(`/v1/agents/${encodeURIComponent(agent.id)}`, {
    method: "POST",
    body: { version:agent.apiVersion, tools },
    capability: UPDATE_AGENT_CAPABILITY,
  }).then(toUiAgent);
}

export function modelInputForSelection(model) {
  if (!model || typeof model.provider !== "string" || typeof model.id !== "string") {
    throw new Error("A deployment model must be selected");
  }
  return model.default && model.provider === "anthropic"
    ? model.id
    : { provider: model.provider, id: model.id };
}

export function listModelCatalog() {
  return fetchCursorPages("/v1/model-catalog");
}

export function createEnvironment(body) {
  return request("/v1/environments", {
    method: "POST",
    body,
    capability: CREATE_ENVIRONMENT_CAPABILITY,
  }).then(toUiEnvironment);
}

export function archiveEnvironment(environmentId) {
  return request(`/v1/environments/${encodeURIComponent(environmentId)}/archive`, {
    method: "POST",
    capability: ARCHIVE_ENVIRONMENT_CAPABILITY,
  }).then(toUiEnvironment);
}

export function deleteEnvironment(environmentId) {
  return request(`/v1/environments/${encodeURIComponent(environmentId)}`, {
    method: "DELETE",
    capability: DELETE_ENVIRONMENT_CAPABILITY,
  });
}

export function listEnvironmentNetworkingPresets() {
  return request("/v1/environments/networking-presets")
    .then((response) => {
      const rows = Array.isArray(response?.presets) ? response.presets : [];
      return {
        deployment: response?.deployment ?? {
          provider:null,
          egress_supported:false,
          reason:"Networking capability was not reported by this deployment.",
        },
        presets: rows.map(toUiNetworkingPreset),
        custom: response?.custom ?? {
          https_only:true,
          wildcard_matches_bare_domain:false,
        },
      };
    });
}

export function validateEnvironmentNetworkingHosts(allowedHosts) {
  return request("/v1/environments/networking-presets/validate", {
    method: "POST",
    body: { allowed_hosts: allowedHosts },
    capability: VALIDATE_ENVIRONMENT_NETWORKING_CAPABILITY,
  }).then((response) => {
    const hosts = response?.allowed_hosts ?? response?.normalized_allowed_hosts ?? response?.data?.allowed_hosts;
    return Array.isArray(hosts) ? hosts : [];
  });
}

export function createSession(body, { intent, agentNames } = {}) {
  return request("/v1/sessions", {
    method: "POST",
    body,
    capability: CREATE_SESSION_CAPABILITY,
    headers: { "idempotency-key": keyForIntent(intent, body) },
  }).then((session) => toUiSession(session, agentNames ?? new Map()));
}

export function archiveSession(sessionId) {
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}/archive`, {
    method: "POST",
    capability: ARCHIVE_SESSION_CAPABILITY,
  });
}

export function deleteSession(sessionId) {
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    capability: DELETE_SESSION_CAPABILITY,
  });
}

export function sendSessionEvents(sessionId, events, { intent } = {}) {
  const body = { events };
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
    method: "POST",
    body,
    capability: SEND_SESSION_EVENTS_CAPABILITY,
    headers: { "idempotency-key": keyForIntent(intent, body) },
  });
}

export function followSessionEvents(sessionId, {
  signal,
  onEvent,
  onState,
  lastEventId,
  fetchImpl,
  maxReconnects,
  reconnectDelayMs,
  maxFrameBytes,
} = {}) {
  const path = `/v1/sessions/${encodeURIComponent(sessionId)}/events/stream`;
  return followEventStream({
    url: path,
    headers: { ...buildRequestHeaders(path, credentials), accept:"text/event-stream" },
    signal,
    onEvent,
    onState,
    lastEventId,
    fetchImpl,
    maxReconnects,
    reconnectDelayMs,
    maxFrameBytes,
  }).catch((error) => {
    if (error?.status === 401) clearKeyForPath(path, credentials);
    throw error;
  });
}

function keyForIntent(intent, payload) {
  const target = intent ?? createIdempotencyIntent();
  const fingerprint = JSON.stringify(payload);
  if (target.key === null || target.fingerprint !== fingerprint) {
    target.key = newIdempotencyKey();
    target.fingerprint = fingerprint;
  }
  return target.key;
}

function newIdempotencyKey() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

// Browser navigation on an <a href> cannot attach x-api-key, so authenticated
// file content downloads go through fetch -> Blob -> object URL instead
// (0120 review, Codex finding).
export async function downloadFile(href, filename) {
  const response = await fetch(href, {
    headers: buildRequestHeaders(href, credentials),
  });
  if (!response.ok) {
    if (response.status === 401) clearKeyForPath(href, credentials);
    const error = new Error(`Download failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Deferred a tick: revoking synchronously races the browser's grab of the
  // blob in some engines.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function fetchCursorPages(path, { limit = PAGE_LIMIT, cursorParam = "page" } = {}) {
  const data = [];
  let cursor = null;
  for (let pageCount = 0; pageCount < MAX_AUTO_PAGES; pageCount += 1) {
    const url = new URL(path, window.location.origin);
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set(cursorParam, cursor);
    const page = await fetchJson(url.pathname + url.search);
    data.push(...(Array.isArray(page?.data) ? page.data : []));
    cursor = page.next_page;
    if (!page?.has_more && !cursor) return { data, truncated: false };
    if (!cursor) return { data, truncated: true };
  }
  return { data, truncated: true };
}

async function fetchFilePages(path, { limit = PAGE_LIMIT } = {}) {
  const data = [];
  let afterId = null;
  for (let pageCount = 0; pageCount < MAX_AUTO_PAGES; pageCount += 1) {
    const url = new URL(path, window.location.origin);
    url.searchParams.set("limit", String(limit));
    if (afterId) url.searchParams.set("after_id", afterId);
    const page = await fetchJson(url.pathname + url.search);
    data.push(...(Array.isArray(page?.data) ? page.data : []));
    if (!page?.has_more) return { data, truncated: false };
    afterId = page.last_id;
    if (!afterId) return { data, truncated: true };
  }
  return { data, truncated: true };
}

export async function loadConsoleData() {
  const [agentsPage, sessionsPage, environmentsPage, filesPage, modelsPage, networkingCatalog, vaultsPage, skillsPage] =
    await Promise.all([
      fetchCursorPages("/v1/agents?include_archived=true"),
      fetchCursorPages("/v1/sessions?include_archived=true&order=desc"),
      fetchCursorPages("/v1/environments?include_archived=true"),
      fetchFilePages("/v1/files"),
      listModelCatalog(),
      listEnvironmentNetworkingPresets(),
      listVaults(),
      listSkills(),
    ]);

  const agents = agentsPage.data.map(toUiAgent);
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const sessions = sessionsPage.data.map((session) =>
    toUiSession(session, agentNames));
  const environments = environmentsPage.data.map(toUiEnvironment);
  const files = filesPage.data.map(toUiFile);
  const warnings = paginationWarnings([
    ["agents", agentsPage],
    ["sessions", sessionsPage],
    ["environments", environmentsPage],
    ["files", filesPage],
    ["models", modelsPage],
  ]);

  return { agents, sessions, environments, files, models: modelsPage.data, networkingCatalog, vaults: vaultsPage.data, skills: skillsPage.data, warnings };
}

async function hydrateSession(session) {
  const [eventsPage, filesPage] = await Promise.all([
    fetchCursorPages(`/v1/sessions/${encodeURIComponent(session.id)}/events?order=asc`, { limit: EVENT_PAGE_LIMIT }),
    fetchFilePages(`/v1/files?scope_id=${encodeURIComponent(session.id)}`),
  ]);
  const sessionSignals = sessionSignalsFromEvents(eventsPage.data);
  const events = toUiEvents(eventsPage.data);
  return {
    ...session,
    ...sessionSignals,
    events,
    files: filesPage.data.map(toUiFile),
    spans: toUiSpans(events),
    warnings: paginationWarnings([
      ["events", eventsPage],
      ["files", filesPage],
    ]),
  };
}

function paginationWarnings(pages) {
  return pages
    .filter(([, page]) => page.truncated)
    .map(([name]) =>
      `${name} reached the ${MAX_AUTO_PAGES}-page safety cap; this view may be partial.`);
}

function toUiAgent(agent) {
  const modelId = agent.model?.id ?? String(agent.model ?? "unknown");
  const modelProvider = agent.model?.provider ?? "anthropic";
  return {
    id: agent.id,
    short: shortId(agent.id),
    name: agent.name || agent.id,
    model: `${modelProvider}/${modelId}`,
    modelId,
    modelProvider,
    status: agent.archived_at ? "archived" : "active",
    created: shortDate(agent.created_at),
    updated: shortDate(agent.updated_at),
    version: `v${agent.version ?? 1}`,
    apiVersion: agent.version ?? 1,
    rawTools: Array.isArray(agent.tools) ? agent.tools : [],
    mcpServers: Array.isArray(agent.mcp_servers) ? agent.mcp_servers : [],
    skills: Array.isArray(agent.skills) ? agent.skills : [],
    metadata: agent.metadata && typeof agent.metadata === "object" ? agent.metadata : {},
    description: agent.description || null,
    tools: Array.isArray(agent.tools) ? agent.tools.length : 0,
    system: agent.system || "No system prompt set.",
    toolset: summarizeToolset(agent.tools),
    toolPermission: summarizeToolPermission(agent.tools),
    sessions: [],
  };
}

function toUiSession(session, agentNames) {
  const agentId = session.agent?.id ?? "unknown-agent";
  return {
    id: session.id,
    short: shortId(session.id),
    title: session.title || session.id,
    status: toUiStatus(session),
    agent: agentNames.get(agentId) ?? agentId,
    agentId,
    env: session.environment_id,
    created: shortDate(session.created_at),
    updated: shortDate(session.updated_at),
    dur: "—",
    tokens: usageLabel(session.usage),
    resources: Array.isArray(session.resources) ? session.resources.length : 0,
    requiresAction: stopReasonType(session.stop_reason) === "requires_action",
  };
}

function toUiEnvironment(environment) {
  const networking = environment.config?.networking;
  const allowedHosts = Array.isArray(networking?.allowed_hosts)
    ? networking.allowed_hosts.length
    : 0;
  const provider = environment.config?.sandbox_provider ?? "deployment provider";
  const networkingSummary = networking?.type === "limited"
    ? (allowedHosts ? `${allowedHosts} allowed host${allowedHosts === 1 ? "" : "s"}` : "offline")
    : "deployment policy";
  return {
    id: environment.id,
    label: environment.name || environment.id,
    image: networking?.type === "limited"
      ? `${provider} · ${networkingSummary}`
      : provider,
    networkingSummary,
    allowedHosts,
    created: shortDate(environment.created_at),
    config: environment.config ?? {},
    metadata: environment.metadata && typeof environment.metadata === "object"
      ? environment.metadata
      : {},
    archived: Boolean(environment.archived_at),
  };
}

function toUiNetworkingPreset(preset) {
  const rawHosts = preset.networking?.allowed_hosts ?? [];
  const allowedHosts = Array.isArray(rawHosts) ? rawHosts : [];
  const id = String(preset.id ?? (allowedHosts.length ? "custom" : "offline-v1"));
  return {
    id,
    version: preset.version ?? 1,
    label: preset.name ?? titleForPresetId(id),
    description: preset.description ?? "",
    allowed_hosts: allowedHosts,
    config: { networking: { type: "limited", allowed_hosts: allowedHosts } },
  };
}

function titleForPresetId(id) {
  if (id === "offline-v1") return "Offline";
  if (id === "npm-pypi-v1") return "npm + PyPI";
  if (id === "github-packages-v1") return "GitHub + package registries";
  return id.replace(/[-_]+/g, " ");
}

function toUiFile(file) {
  const extension = file.filename.includes(".")
    ? file.filename.split(".").pop().slice(0, 4)
    : "file";
  return {
    id: file.id,
    name: file.filename,
    ext: extension,
    type: file.mime_type,
    size: formatBytes(file.size_bytes),
    created: shortDate(file.created_at),
    dl: Boolean(file.downloadable),
    href: `/v1/files/${encodeURIComponent(file.id)}/content`,
    scope: file.scope,
  };
}

function toUiEvents(events) {
  const firstTime = firstProcessedAt(events);
  return events.map((event) => toUiEvent(event, firstTime));
}

export function toUiSessionEvent(event, firstTime = null) {
  return toUiEvent(event, firstTime);
}

function toUiEvent(event, firstTime) {
  const role = eventRole(event.type);
  const content = contentText(event);
  const usage = event.type === "span.model_request_end"
    ? modelUsage(event.model_usage)
    : null;
  return {
    id: event.id,
    role,
    type: event.type,
    tag: eventTag(event),
    transcript: isTranscriptEvent(event),
    time: relativeTime(event.processed_at, firstTime),
    text: eventSummary(event, content),
    content,
    raw: JSON.stringify(event, null, 2),
    ok: event.type !== "session.error" && event.is_error !== true,
    open: false,
    tokens: usage ? `${usage.input} / ${usage.output}` : undefined,
    dur: undefined,
    pairedStart: event.model_request_start_id,
    usage,
    source: event,
    confirm: (event.type === "agent.tool_use" || event.type === "agent.mcp_tool_use") && event.evaluated_permission === "ask",
    tool: event.name,
    cmd: event.input?.command ?? event.input?.cmd ?? JSON.stringify(event.input ?? {}),
  };
}

function toUiSpans(events) {
  const modelStarts = new Map();
  const spans = [];
  for (const event of events) {
    if (event.type === "span.model_request_start") {
      modelStarts.set(event.id, event);
      continue;
    }
    if (event.type === "span.model_request_end") {
      const start = modelStarts.get(event.pairedStart);
      spans.push({
        role: "span",
        kind: event.ok ? "model" : "error",
        label: "model_request",
        left: 4 + spans.length * 18,
        width: 14,
        info: event.tokens ?? "model",
        eventId: event.id,
      });
      if (start) modelStarts.delete(start.id);
    }
  }
  for (const start of modelStarts.values()) {
    spans.push({
      role: "span",
      kind: "open",
      label: "model_request",
      left: 4 + spans.length * 18,
      width: 12,
      info: "open — no end",
      eventId: start.id,
    });
  }
  return spans;
}

function summarizeToolset(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "No tools configured";
  const first = tools[0];
  if (first?.type === "agent_toolset_20260401") return "agent_toolset_20260401";
  return `${tools.length} tool${tools.length === 1 ? "" : "s"}`;
}

function summarizeToolPermission(tools) {
  const policies = new Set();
  for (const toolset of Array.isArray(tools) ? tools : []) {
    if (toolset?.type !== "agent_toolset_20260401") continue;
    for (const tool of effectiveBuiltinTools(toolset)) {
      if (!tool.enabled) continue;
      policies.add(tool.policy);
    }
  }
  if (policies.size === 0) return "No enabled tools";
  if (policies.size > 1) return "Mixed permissions";
  const [policy] = policies;
  if (policy === "always_ask") return "Ask before use";
  if (policy === "deny") return "Denied";
  return "Always allow";
}

function effectiveBuiltinTools(toolset) {
  const defaultEnabled = toolset?.default_config?.enabled !== false;
  const defaultPolicy = toolset?.default_config?.permission_policy?.type ?? "always_allow";
  const configs = new Map(
    (Array.isArray(toolset?.configs) ? toolset.configs : [])
      .map((config) => [config.name, config]),
  );
  return CMA_BUILTIN_TOOL_NAMES.map((name) => {
    const config = configs.get(name);
    return {
      name,
      enabled: config?.enabled ?? defaultEnabled,
      policy: config?.permission_policy?.type ?? defaultPolicy,
    };
  });
}

function eventRole(type) {
  if (type.startsWith("user.")) return "user";
  if (type.startsWith("agent.tool") || type.includes("tool_")) return "tool";
  if (type.startsWith("agent.")) return "agent";
  if (type.startsWith("span.")) return "span";
  return "sys";
}

function eventTag(event) {
  if (event.type === "agent.tool_use") return event.name ?? "tool";
  if (event.type === "agent.tool_result") return event.is_error ? "error" : "exit 0";
  if (event.type === "agent.mcp_tool_use") return event.name ?? "mcp tool";
  if (event.type === "agent.mcp_tool_result") return event.is_error ? "error" : "mcp result";
  if (event.type === "span.model_request_end") return event.is_error ? "error" : "model";
  if (event.type === "session.error") return "error";
  if (event.type.startsWith("session.status_")) return event.type.slice("session.status_".length);
  return event.type.split(".").pop();
}

function eventSummary(event, content) {
  if (content) return content.split("\n")[0];
  if (event.type === "session.error") return event.error?.message ?? event.message ?? "session.error";
  if (event.type === "agent.tool_use") return `agent.tool_use · ${event.name ?? "tool"}`;
  if (event.type === "agent.tool_result") return `agent.tool_result · ${event.is_error ? "error" : "ok"}`;
  if (event.type === "agent.mcp_tool_use") return `agent.mcp_tool_use · ${event.name ?? "tool"}`;
  if (event.type === "agent.mcp_tool_result") return `agent.mcp_tool_result · ${event.is_error ? "error" : "ok"}`;
  if (event.type === "span.model_request_start") return "model_request_start";
  if (event.type === "span.model_request_end") return "model_request_end";
  return event.type;
}

function isTranscriptEvent(event) {
  return [
    "user.message",
    "user.interrupt",
    "user.custom_tool_result",
    "user.tool_confirmation",
    "agent.message",
    "agent.tool_use",
    "agent.tool_result",
    "agent.mcp_tool_use",
    "agent.mcp_tool_result",
    "agent.custom_tool_use",
  ].includes(event.type);
}

function contentText(event) {
  if (Array.isArray(event.content)) {
    return event.content
      .map((block) => block?.text ?? block?.content ?? JSON.stringify(block))
      .join("\n");
  }
  if (typeof event.content === "string") return event.content;
  if (event.input) return JSON.stringify(event.input, null, 2);
  return "";
}

function modelUsage(usage) {
  if (!usage) return null;
  return {
    input: numberLabel(usage.input_tokens ?? 0),
    output: numberLabel(usage.output_tokens ?? 0),
    cacheRead: numberLabel(usage.cache_read_input_tokens ?? 0),
    cacheWrite: numberLabel(usage.cache_creation_input_tokens ?? 0),
  };
}

function usageLabel(usage) {
  if (!usage) return "—";
  return `${usage.input_tokens ?? 0} / ${usage.output_tokens ?? 0}`;
}

function toUiStatus(session) {
  if (session.archived_at) return "archived";
  return session.status;
}

function sessionSignalsFromEvents(events) {
  const latestIdle = [...events].reverse()
    .find((event) => event.type === "session.status_idle");
  const sessionError = [...events].reverse()
    .find((event) => event.type === "session.error");
  return {
    requiresAction: stopReasonType(latestIdle?.stop_reason) === "requires_action",
    sessionError: sessionError ? {
      id: sessionError.id,
      type: sessionError.error?.type ?? sessionError.type,
      message: sessionError.error?.message ?? sessionError.message ?? "The session emitted an error.",
    } : null,
  };
}

function stopReasonType(stopReason) {
  return stopReason && typeof stopReason === "object" ? stopReason.type : undefined;
}

function firstProcessedAt(events) {
  const event = events.find((item) => item.processed_at);
  return event?.processed_at ? Date.parse(event.processed_at) : null;
}

function relativeTime(value, firstTime) {
  if (!value || !firstTime) return "queued";
  const seconds = Math.max(0, Math.round((Date.parse(value) - firstTime) / 1000));
  return `0:${String(seconds).padStart(2, "0")}`;
}

function shortId(id) {
  if (!id || id.length <= 14) return id;
  return `${id.slice(0, 5)}…${id.slice(-6)}`;
}

function shortDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" })
    .format(new Date(value));
}

function numberLabel(value) {
  return new Intl.NumberFormat("en").format(value);
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

// The JSX (compiled by in-browser Babel, not module-scoped) reaches the API
// through this global; Node tests import the module exports directly.
if (typeof window !== "undefined") {
  window.OmaConsoleApi = {
    loadConsoleData,
    hydrateSession,
    setAdminKey,
    setWorkspaceKey,
    clearCredentials,
    hasWorkspaceKey,
    canSubmitToolConfirmation,
    createWorkspace,
    listWorkspaces,
    mintKey,
    listKeys,
    revokeKey,
    getConsoleAuthStatus,
    loginConsoleWorkspace,
    consumeConsoleBootstrap,
    loginConsoleAdmin,
    selectConsoleWorkspace,
    logoutConsole,
    listVaults,
    listVaultCredentials,
    createVault,
    createVaultCredential,
    listSkills,
    createSkill,
    listWorkspaceCredentialHealth,
    validateMcpOauthCredential,
    createIdempotencyIntent,
    createAgent,
    archiveAgent,
    updateAgentToolPermission,
    modelInputForSelection,
    listModelCatalog,
    createEnvironment,
    archiveEnvironment,
    deleteEnvironment,
    listEnvironmentNetworkingPresets,
    validateEnvironmentNetworkingHosts,
    createSession,
    archiveSession,
    deleteSession,
    sendSessionEvents,
    followSessionEvents,
    toUiSessionEvent,
    downloadFile,
  };
}
