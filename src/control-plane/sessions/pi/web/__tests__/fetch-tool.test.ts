import { describe, expect, it } from "vitest";
import type { WebFetchOptions, WebFetchResult } from "../../../../egress/guarded-fetch.ts";
import { parseNetworkingConfig, type EgressPolicy } from "../../../../egress/policy.ts";
import { createWebFetchTool, type WebToolContext } from "../fetch-tool.ts";
import type { ProvenanceEvent } from "../provenance.ts";

// Plan 0149 slice 1d: the web_fetch tool's own logic, in hosted's order. The
// fetcher is faked but still runs the real URL validator; the guarded fetch
// itself is tested against real servers in egress/__tests__.

const policy = parseNetworkingConfig({
  networking: { type: "limited", allowed_hosts: ["docs.example.com", "example.com"] },
}) as EgressPolicy;

const userSaid = (text: string): ProvenanceEvent => ({
  id: "sevt_user", type: "user.message", processed_at: new Date().toISOString(),
  payload: { content: [{ type: "text", text }] },
});

function fakeWeb(pages: Record<string, { status?: number; type?: string; body: string }>) {
  const requested: string[] = [];
  const fetchResource = async (url: string, options: WebFetchOptions): Promise<WebFetchResult> => {
    requested.push(url);
    const check = options.validate(url);
    if (!check.ok) return { ok: false, code: check.code, reason: check.reason, url };
    const page = pages[url];
    if (!page) return { ok: false, code: "fetch_failed", reason: "no such page", url };
    return {
      ok: true, finalUrl: url, status: page.status ?? 200, contentType: page.type ?? "text/html",
      body: new TextEncoder().encode(page.body), truncated: false,
    };
  };
  return { requested, fetchResource };
}

async function run(url: string, context: WebToolContext, web = fakeWeb({})) {
  const tool = createWebFetchTool({ context: async () => context, fetchResource: web.fetchResource });
  return tool.execute("toolu_1", { url }, undefined, undefined, undefined as never);
}

describe("web_fetch tool", () => {
  it("refuses when the environment allows no web hosts, without fetching", async () => {
    const web = fakeWeb({});

    await expect(run("https://docs.example.com/", { policy: undefined, events: [userSaid("https://docs.example.com/")] }, web))
      .rejects.toThrow("url_not_allowed");
    expect(web.requested).toEqual([]);
  });

  it("refuses a URL the session never showed, without fetching", async () => {
    const web = fakeWeb({});

    await expect(run("https://docs.example.com/secret", { policy, events: [userSaid("read the docs")] }, web))
      .rejects.toThrow("url_not_in_prior_context");
    expect(web.requested).toEqual([]);
  });

  it("returns a shown page's text to the model", async () => {
    const web = fakeWeb({ "https://docs.example.com/": { body: "<title>Docs</title><h1>Welcome</h1>" } });

    const result = await run("https://docs.example.com/", { policy, events: [userSaid("see https://docs.example.com/")] }, web);

    expect(result.content).toEqual([{ type: "text", text: "# Welcome" }]);
  });

  it("publishes hosted's document block for the event", async () => {
    const web = fakeWeb({ "https://docs.example.com/": { body: "<title>Docs</title><h1>Welcome</h1>" } });

    const result = await run("https://docs.example.com/", { policy, events: [userSaid("see https://docs.example.com/")] }, web);

    expect(result.details.omaToolResultContent).toEqual([{
      type: "document", title: "Docs", context: null,
      source: { type: "text", media_type: "text/plain", data: "# Welcome" },
    }]);
  });

  it("fetches the shown URL for a near match, with hosted's note", async () => {
    const web = fakeWeb({ "https://example.com/trace": { type: "text/plain", body: "ok" } });

    const result = await run("https://www.example.com/trace/", { policy, events: [userSaid("https://example.com/trace")] }, web);

    const first = result.content[0];
    const text = first?.type === "text" ? first.text : "";

    expect([web.requested, text.startsWith("Note: fetched https://example.com/trace")]).toEqual([["https://example.com/trace"], true]);
  });

  it("refuses a shown URL on a host the environment does not allow", async () => {
    await expect(run("https://elsewhere.example.net/", { policy, events: [userSaid("https://elsewhere.example.net/")] }))
      .rejects.toThrow("url_not_allowed");
  });

  it("reports an HTTP error status as an error", async () => {
    const web = fakeWeb({ "https://docs.example.com/missing": { status: 404, body: "nope" } });

    await expect(run("https://docs.example.com/missing", { policy, events: [userSaid("https://docs.example.com/missing")] }, web))
      .rejects.toThrow("http_404");
  });
});
