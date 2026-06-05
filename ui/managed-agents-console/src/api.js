// api.js — public OMA REST adapter for the static Managed Agents Console.

const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
const FILES_API_BETA = "files-api-2025-04-14";
const BETA_HEADER = `${MANAGED_AGENTS_BETA}, ${FILES_API_BETA}`;
const PAGE_LIMIT = 100;
const EVENT_PAGE_LIMIT = 1000;
const MAX_AUTO_PAGES = 100;

async function fetchJson(path) {
  const response = await fetch(path, {
    headers: {
      "anthropic-beta": BETA_HEADER,
      "accept": "application/json",
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = body?.error?.message ?? `Request failed (${response.status})`;
    const error = new Error(message);
    error.response = body;
    error.status = response.status;
    throw error;
  }
  return body;
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
  const events = toUiEvents(eventsPage.data);
  return {
    ...session,
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
    ok: event.is_error !== true,
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
        kind: event.ok ? "model" : "open",
        label: "model_request",
        left: 4 + spans.length * 18,
        width: 14,
        info: event.tokens ?? "model",
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
  if (event.type.startsWith("session.status_")) return event.type.slice("session.status_".length);
  return event.type.split(".").pop();
}

function eventSummary(event, content) {
  if (content) return content.split("\n")[0];
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
  if (session.status === "rescheduling") return "running";
  return session.status;
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

window.OmaConsoleApi = {
  loadConsoleData,
  hydrateSession,
};
