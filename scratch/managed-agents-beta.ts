export const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";

export function withManagedAgentsBeta(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has("anthropic-beta")) {
    headers.set("anthropic-beta", MANAGED_AGENTS_BETA);
  }
  return { ...init, headers };
}

export function fetchWithManagedAgentsBeta(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): ReturnType<typeof fetch> {
  return fetch(input, withManagedAgentsBeta(init));
}

export function requestWithManagedAgentsBeta(
  app: {
    request: (input: string, init?: RequestInit) => Response | Promise<Response>;
  },
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return Promise.resolve(app.request(path, withManagedAgentsBeta(init)));
}
