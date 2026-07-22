import { createHash } from "node:crypto";
import { MANAGED_AGENTS_BETA } from "../src/control-plane/api-constants.ts";

const MARKER = "oma.onboarding";
const MARKER_VERSION = "starter-v1";

interface ApiResource {
  id: string;
  archived_at: string | null;
  metadata?: Record<string, string>;
}

interface AgentResource extends ApiResource {
  model: { provider: string; id: string };
}

interface EnvironmentResource extends ApiResource {
  config: Record<string, unknown>;
}

interface SessionResource extends ApiResource {
  agent: { id: string };
  environment_id: string;
}

type ApiRequest = <T>(path: string, options?: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<T>;

export interface StarterResources {
  agentId: string;
  environmentId: string;
  sessionId: string;
  model: { provider: string; id: string };
  created: Array<"agent" | "environment" | "session">;
  warnings: string[];
}

export async function ensureStarterResources(input: {
  baseUrl: string;
  workspaceKey: string;
  provider: string;
  fetch?: typeof fetch;
}): Promise<StarterResources> {
  const request = createApiRequest(input.baseUrl, input.workspaceKey, input.fetch ?? fetch);
  const warnings: string[] = [];
  const created: StarterResources["created"] = [];
  const models = await listAll<{ provider: string; id: string; default: boolean }>(request, `/v1/model-catalog?available=true&provider=${encodeURIComponent(input.provider)}`);
  const model = models.find((item) => item.default) ?? models[0];
  if (model === undefined) throw new Error(`No credential-ready model is available for provider ${input.provider}`);

  const agentRows = await listAll<AgentResource>(request, "/v1/agents?include_archived=true");
  const markedAgents = agentRows.filter((item) => hasMarker(item, "agent"));
  let agent = markedAgents.find((item) => item.archived_at === null && item.model.provider === model.provider && item.model.id === model.id);
  if (agent === undefined) {
    if (markedAgents.length > 0) warnings.push("The previous starter agent was archived or used a different model; a compatible starter agent was created.");
    agent = await request<AgentResource>("/v1/agents", {
      method: "POST",
      body: {
        name: "OMA Starter",
        model: { provider: model.provider, id: model.id },
        description: "Local starter agent created by oma onboard.",
        system: "You are the local Open Managed Agents starter. Help the operator explore this workspace clearly and safely.",
        tools: [], skills: [], mcp_servers: [],
        metadata: marker("agent"),
      },
    });
    created.push("agent");
  }

  const environmentRows = await listAll<EnvironmentResource>(request, "/v1/environments?include_archived=true");
  const markedEnvironments = environmentRows.filter((item) => hasMarker(item, "environment"));
  let environment = markedEnvironments.find((item) => item.archived_at === null && isOffline(item.config));
  if (environment === undefined) {
    if (markedEnvironments.length > 0) warnings.push("The previous starter environment was archived or no longer offline; a new offline environment was created.");
    environment = await request<EnvironmentResource>("/v1/environments", {
      method: "POST",
      body: {
        name: "OMA Starter (offline)",
        config: { type: "cloud", networking: { type: "limited", allowed_hosts: [] } },
        metadata: marker("environment"),
      },
    });
    created.push("environment");
  }

  const sessionRows = await listAll<SessionResource>(request, "/v1/sessions?include_archived=true");
  const markedSessions = sessionRows.filter((item) => hasMarker(item, "session"));
  let session = markedSessions.find((item) => item.archived_at === null && item.agent.id === agent!.id && item.environment_id === environment!.id);
  if (session === undefined) {
    if (markedSessions.length > 0) warnings.push("The previous starter session was archived or referenced older starter resources; a new session was created.");
    session = await request<SessionResource>("/v1/sessions", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey(agent.id, environment.id) },
      body: {
        agent: agent.id,
        environment_id: environment.id,
        title: "Your first OMA session",
        metadata: marker("session"),
      },
    });
    created.push("session");
  }

  return {
    agentId: agent.id,
    environmentId: environment.id,
    sessionId: session.id,
    model: { provider: model.provider, id: model.id },
    created,
    warnings,
  };
}

function marker(resource: string): Record<string, string> {
  return { [MARKER]: MARKER_VERSION, "oma.onboarding.resource": resource };
}

function hasMarker(resource: ApiResource, kind: string): boolean {
  return resource.metadata?.[MARKER] === MARKER_VERSION && resource.metadata["oma.onboarding.resource"] === kind;
}

function isOffline(config: Record<string, unknown>): boolean {
  const networking = config.networking as { type?: unknown; allowed_hosts?: unknown } | undefined;
  return networking?.type === "limited" && Array.isArray(networking.allowed_hosts) && networking.allowed_hosts.length === 0;
}

function idempotencyKey(agentId: string, environmentId: string): string {
  return `oma-onboard-${createHash("sha256").update(`${MARKER_VERSION}:${agentId}:${environmentId}`).digest("hex").slice(0, 32)}`;
}

function createApiRequest(baseUrl: string, workspaceKey: string, fetchImpl: typeof fetch) {
  return async function request<T>(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const response = await fetchImpl(new URL(path, baseUrl), {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        "anthropic-beta": MANAGED_AGENTS_BETA,
        "x-api-key": workspaceKey,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const body = await response.json().catch(() => undefined) as unknown;
    if (!response.ok) {
      const message = typeof body === "object" && body !== null && "error" in body
        ? (body as { error?: { message?: string } }).error?.message
        : undefined;
      throw new Error(message ?? `OMA API ${options.method ?? "GET"} ${path} failed with HTTP ${response.status}`);
    }
    return body as T;
  };
}

async function listAll<T>(request: ApiRequest, initialPath: string): Promise<T[]> {
  const data: T[] = [];
  let path: string | undefined = addLimit(initialPath);
  for (let pageCount = 0; path !== undefined && pageCount < 100; pageCount += 1) {
    const page: { data: T[]; has_more: boolean; next_page: string | null } = await request(path);
    data.push(...page.data);
    path = page.has_more && page.next_page ? addPage(initialPath, page.next_page) : undefined;
  }
  return data;
}

function addLimit(path: string): string {
  const url = new URL(path, "http://oma.local");
  url.searchParams.set("limit", "100");
  return `${url.pathname}${url.search}`;
}

function addPage(path: string, page: string): string {
  const url = new URL(path, "http://oma.local");
  url.searchParams.set("limit", "100");
  url.searchParams.set("page", page);
  return `${url.pathname}${url.search}`;
}
