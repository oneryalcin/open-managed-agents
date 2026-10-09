import { describe, expect, it } from "vitest";
import { parseNetworkingConfig, type EgressPolicy } from "../../../../egress/policy.ts";
import { createTavilySearchProvider, type WebSearchProvider, type WebSearchResult } from "../search-provider.ts";
import { createWebSearchTool, searchDomains } from "../search-tool.ts";

// Plan 0149 slice 2: web_search through a pluggable provider (Tavily first).
// No query leaves when no hosts are allowed; results are re-checked against
// the policy; the provider's key never reaches the model or events.

const policy = (hosts: string[]) =>
  parseNetworkingConfig({ networking: { type: "limited", allowed_hosts: hosts } }) as EgressPolicy;

function recordingProvider(results: WebSearchResult[]) {
  const calls: Array<{ query: string; domains: readonly string[] }> = [];
  const provider: WebSearchProvider = {
    search: async (query, domains) => {
      calls.push({ query, domains });
      return results;
    },
  };
  return { calls, provider };
}

async function search(query: string, hosts: string[] | undefined, provider: WebSearchProvider) {
  const tool = createWebSearchTool({
    context: async () => ({ policy: hosts === undefined ? undefined : policy(hosts), events: [] }),
    provider,
  });
  return tool.execute("toolu_s", { query }, undefined, undefined, undefined as never);
}

describe("web_search tool", () => {
  it("sends no query when the environment allows no web hosts", async () => {
    const { calls, provider } = recordingProvider([]);

    await expect(search("anything", undefined, provider)).rejects.toThrow("url_not_allowed");
    expect(calls).toEqual([]);
  });

  it("restricts the provider to the allowed hosts, wildcards as their domain", async () => {
    const { calls, provider } = recordingProvider([]);

    await search("guide", ["docs.example.com", "*.example.org"], provider).catch(() => {});

    expect(calls[0]?.domains).toEqual(["docs.example.com", "example.org"]);
  });

  it("drops a result the policy does not allow, even if the provider returns it", async () => {
    const { provider } = recordingProvider([
      { url: "https://docs.example.com/a", title: "A", content: "allowed" },
      { url: "https://evil.example.net/b", title: "B", content: "not allowed" },
    ]);

    const result = await search("guide", ["docs.example.com"], provider);

    expect(JSON.parse(result.details.omaToolResultContent as string).map((r: { source: string }) => r.source))
      .toEqual(["https://docs.example.com/a"]);
  });

  it("returns hosted's search result blocks as a JSON string", async () => {
    const { provider } = recordingProvider([{ url: "https://docs.example.com/a", title: "A", content: "text" }]);

    const result = await search("guide", ["docs.example.com"], provider);

    expect(JSON.parse(result.details.omaToolResultContent as string)).toEqual([{
      type: "search_result", source: "https://docs.example.com/a", title: "A",
      content: [{ type: "text", text: "text" }], citations: { enabled: true },
    }]);
  });

  it("keeps local and internal names out of the provider's domain list", () => {
    expect(searchDomains(policy(["docs.example.com", "intranet.local", "db.internal"])))
      .toEqual(["docs.example.com"]);
  });
});

describe("Tavily provider", () => {
  const KEY = "tvly-test-key-0123456789abcdef";

  function tavily(respond: (body: Record<string, unknown>) => { status: number; json: unknown }) {
    const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const provider = createTavilySearchProvider({
      apiKey: KEY,
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ url: String(url), headers: init?.headers as Record<string, string>, body });
        const answer = respond(body);
        return new Response(JSON.stringify(answer.json), { status: answer.status });
      },
    });
    return { provider, requests };
  }

  it("asks Tavily to restrict results to the given domains", async () => {
    const { provider, requests } = tavily(() => ({ status: 200, json: { results: [] } }));

    await provider.search("guide", ["docs.example.com"]);

    expect(requests[0]?.body).toMatchObject({
      query: "guide", include_domains: ["docs.example.com"], include_domains_mode: "restrict",
    });
  });

  it("maps Tavily results to title, URL and content", async () => {
    const { provider } = tavily(() => ({
      status: 200, json: { results: [{ title: "A", url: "https://docs.example.com/a", content: "text", score: 0.9 }] },
    }));

    expect(await provider.search("guide", ["docs.example.com"])).toEqual([
      { title: "A", url: "https://docs.example.com/a", content: "text" },
    ]);
  });

  it("scrubs its API key from results the provider echoes back", async () => {
    const { provider } = tavily(() => ({
      status: 200, json: { results: [{ title: `key ${KEY}`, url: "https://docs.example.com/a", content: KEY }] },
    }));

    const results = await provider.search("guide", ["docs.example.com"]);

    expect(JSON.stringify(results).includes(KEY)).toBe(false);
  });

  it("scrubs its API key from an error the provider echoes back", async () => {
    const { provider } = tavily(() => ({ status: 401, json: { detail: `bad key ${KEY}` } }));

    const error = await provider.search("guide", ["docs.example.com"]).catch((e: Error) => e);

    expect(String(error).includes(KEY)).toBe(false);
  });

  it("does not leak a key prefix when an error body is cut short", async () => {
    const { provider } = tavily(() => ({ status: 500, json: { detail: `${"x".repeat(280)}${KEY}` } }));

    const error = await provider.search("guide", ["docs.example.com"]).catch((e: Error) => e);

    expect(String(error).includes(KEY.slice(0, 8))).toBe(false);
  });

  it("refuses a response larger than its cap", async () => {
    const provider = createTavilySearchProvider({
      apiKey: KEY,
      maxResponseBytes: 1_000,
      fetch: async () => new Response(JSON.stringify({ results: [{ url: "https://docs.example.com/a", title: "x".repeat(5_000) }] })),
    });

    await expect(provider.search("guide", ["docs.example.com"])).rejects.toThrow("too large");
  });

  it("gives up on a provider that never finishes answering", async () => {
    const provider = createTavilySearchProvider({
      apiKey: KEY,
      timeoutMs: 100,
      fetch: async (_url, init) =>
        new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        })),
    });

    await expect(provider.search("guide", ["docs.example.com"])).rejects.toThrow("timed out");
  });
});
