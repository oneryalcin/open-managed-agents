// api.js — OMA REST adapter for the static Managed Agents Console.
// ES module (plan 0120 §3.3): loaded with type="module" in index.html so the
// pure header logic below is importable by Node tests without a browser.

const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
const FILES_API_BETA = "files-api-2025-04-14";
const BETA_HEADER = `${MANAGED_AGENTS_BETA}, ${FILES_API_BETA}`;
const PAGE_LIMIT = 100;
const EVENT_PAGE_LIMIT = 1000;
const MAX_AUTO_PAGES = 100;
const VALIDATE_CAPABILITY = Symbol("validate-mcp-oauth-credential");

// Session-scoped credentials, in module memory only (plan 0120 §3.2):
// never localStorage, sessionStorage, or a cookie — a reload means
// re-entering the key, and nothing touches disk. The admin key goes to
// /admin routes only, the workspace key to /v1 only; neither crosses tiers.
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

async function request(path, { method = "GET", body, capability } = {}) {
  // fetch() treats the method case-insensitively, so normalize once and gate on
  // the normalized value — otherwise `method: "post"` would slip past the guard.
  const normalizedMethod = String(method).toUpperCase();
  // Keep /v1 writes deny-by-default. New workspace-key writes need a narrowly
  // named capability rather than silently gaining access through this generic
  // transport helper.
  if (normalizedMethod !== "GET" && path.startsWith("/v1/") &&
      !(capability === VALIDATE_CAPABILITY && normalizedMethod === "POST" && isExactValidatePath(path))) {
    throw new Error("Console /v1 writes are not permitted");
  }
  const headers = buildRequestHeaders(path, credentials);
  const init = { method: normalizedMethod, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
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

export function listWorkspaceCredentialHealth(workspaceId, page) {
  const url = new URL(
    `/admin/workspaces/${encodeURIComponent(workspaceId)}/mcp-credentials`,
    window.location.origin,
  );
  url.searchParams.set("limit", String(PAGE_LIMIT));
  if (page) url.searchParams.set("page", page);
  return request(url.pathname + url.search);
}

export function validateMcpOauthCredential(vaultId, credentialId, mode) {
  if (mode !== "api") return Promise.reject(new Error("Validate is only available in live API mode"));
  const path = `/v1/vaults/${encodeURIComponent(vaultId)}/credentials/${encodeURIComponent(credentialId)}/mcp_oauth_validate`;
  return request(path, { method: "POST", capability: VALIDATE_CAPABILITY });
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

async function loadConsoleData() {
  const [agentsPage, sessionsPage, environmentsPage, filesPage] =
    await Promise.all([
      fetchCursorPages("/v1/agents?include_archived=true"),
      fetchCursorPages("/v1/sessions?include_archived=true&order=desc"),
      fetchCursorPages("/v1/environments"),
      fetchFilePages("/v1/files"),
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
  ]);

  return { agents, sessions, environments, files, warnings };
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
  return {
    id: agent.id,
    short: shortId(agent.id),
    name: agent.name || agent.id,
    model: agent.model?.id ?? String(agent.model ?? "unknown"),
    status: agent.archived_at ? "archived" : "active",
    created: shortDate(agent.created_at),
    updated: shortDate(agent.updated_at),
    version: `v${agent.version ?? 1}`,
    tools: Array.isArray(agent.tools) ? agent.tools.length : 0,
    system: agent.system || "No system prompt set.",
    toolset: summarizeToolset(agent.tools),
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
  return {
    id: environment.id,
    label: environment.name || environment.id,
    image: environment.config?.sandbox_provider ?? "local",
  };
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
    createWorkspace,
    listWorkspaces,
    mintKey,
    listKeys,
    revokeKey,
    listVaults,
    listVaultCredentials,
    listWorkspaceCredentialHealth,
    validateMcpOauthCredential,
    downloadFile,
  };
}
