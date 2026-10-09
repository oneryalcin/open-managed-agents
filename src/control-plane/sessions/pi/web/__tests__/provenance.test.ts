import { describe, expect, it } from "vitest";
import { matchShownUrl, shownUrls, type ProvenanceEvent } from "../provenance.ts";

// Plan 0149 slice 1c: hosted's prior-context rule. A URL may be fetched only
// if the session showed it: in a user message, a web_search result, the text
// of a page fetched in the last 30 minutes, or a custom tool result.

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
let seq = 0;
const id = () => `sevt_${++seq}`;

const userMessage = (text: string, minute = 0): ProvenanceEvent => ({
  id: id(), type: "user.message", processed_at: at(minute), payload: { content: [{ type: "text", text }] },
});
const toolUse = (name: string, input: Record<string, unknown>, useId: string, minute = 0): ProvenanceEvent => ({
  id: useId, type: "agent.tool_use", processed_at: at(minute), payload: { name, input },
});
const toolResult = (useId: string, content: unknown, minute = 0, isError = false): ProvenanceEvent => ({
  id: id(), type: "agent.tool_result", processed_at: at(minute), payload: { tool_use_id: useId, content, is_error: isError },
});
const fetchedPage = (useId: string, url: string, text: string, minute = 0, isError = false): ProvenanceEvent[] => [
  toolUse("web_fetch", { url }, useId, minute),
  toolResult(useId, [{ type: "document", title: null, context: null, source: { type: "text", media_type: "text/plain", data: text } }], minute, isError),
];

const match = (events: ProvenanceEvent[], url: string, minute = 1) =>
  matchShownUrl(url, shownUrls(events, new Date(T0 + minute * 60_000)));

describe("URLs shown in a session", () => {
  it("counts a URL from a user message", () => {
    expect(match([userMessage("read https://docs.example.com/guide please")], "https://docs.example.com/guide")?.kind).toBe("exact");
  });

  it("refuses a URL the session never showed", () => {
    expect(match([userMessage("read the docs")], "https://docs.example.com/guide")).toBeUndefined();
  });

  it("counts a URL from a web_search result", () => {
    const events = [
      toolUse("web_search", { query: "guide" }, "sevt_s1"),
      toolResult("sevt_s1", JSON.stringify([{ type: "search_result", source: "https://docs.example.com/a", title: "A" }])),
    ];

    expect(match(events, "https://docs.example.com/a")?.kind).toBe("exact");
  });

  it("counts a link in a fetched page, resolving relative links against the page", () => {
    const events = fetchedPage("sevt_f1", "https://docs.example.com/guide/", "See [install](install.html).");

    expect(match(events, "https://docs.example.com/guide/install.html")?.kind).toBe("exact");
  });

  it("forgets a fetched page's links after 30 minutes", () => {
    const events = fetchedPage("sevt_f2", "https://docs.example.com/", "See https://docs.example.com/next");

    expect(match(events, "https://docs.example.com/next", 31)).toBeUndefined();
  });

  it("keeps a user message's URLs past 30 minutes", () => {
    expect(match([userMessage("https://docs.example.com/x")], "https://docs.example.com/x", 300)?.kind).toBe("exact");
  });

  it("does not count links from a failed fetch", () => {
    const events = fetchedPage("sevt_f3", "https://docs.example.com/", "https://docs.example.com/err", 0, true);

    expect(match(events, "https://docs.example.com/err")).toBeUndefined();
  });

  it("does not count URLs from an MCP tool result", () => {
    const events = [
      { id: "sevt_m1", type: "agent.mcp_tool_use", processed_at: at(0), payload: { name: "search", mcp_server_name: "docs", input: {} } },
      { id: id(), type: "agent.mcp_tool_result", processed_at: at(0), payload: { mcp_tool_use_id: "sevt_m1", content: [{ type: "text", text: "https://evil.example.com/x" }] } },
    ] satisfies ProvenanceEvent[];

    expect(match(events, "https://evil.example.com/x")).toBeUndefined();
  });

  it("counts a URL from a custom tool result", () => {
    const events: ProvenanceEvent[] = [{
      id: id(), type: "user.custom_tool_result", processed_at: at(0),
      payload: { content: [{ type: "text", text: "ticket at https://tracker.example.com/T-1" }] },
    }];

    expect(match(events, "https://tracker.example.com/T-1")?.kind).toBe("exact");
  });

  it("matches across case of the host and a default port", () => {
    expect(match([userMessage("https://Docs.Example.com:443/guide")], "https://docs.example.com/guide")?.kind).toBe("exact");
  });

  it("treats a www. or trailing-slash difference as a near match to the shown URL", () => {
    const found = match([userMessage("https://example.com/cdn-cgi/trace")], "https://www.example.com/cdn-cgi/trace/");

    expect(found).toEqual({ kind: "near", url: "https://example.com/cdn-cgi/trace" });
  });

  it("does not treat a different path as a near match", () => {
    expect(match([userMessage("https://example.com/a")], "https://example.com/b")).toBeUndefined();
  });

  it("keeps trailing punctuation out of a URL in prose", () => {
    expect(match([userMessage("See https://docs.example.com/guide.")], "https://docs.example.com/guide")?.kind).toBe("exact");
  });

  it("does not authorize a URL with punctuation trimmed off its query", () => {
    expect(match([userMessage("https://docs.example.com/send?value=abc!")], "https://docs.example.com/send?value=abc")).toBeUndefined();
  });

  it("keeps balanced parentheses in a URL", () => {
    const events = [userMessage("see https://en.wikipedia.org/wiki/Foo_(bar) for more")];

    expect(match(events, "https://en.wikipedia.org/wiki/Foo_(bar)")?.kind).toBe("exact");
  });

  it("does not count a URL from a failed custom tool result", () => {
    const events: ProvenanceEvent[] = [{
      id: id(), type: "user.custom_tool_result", processed_at: at(0),
      payload: { is_error: true, content: [{ type: "text", text: "failed at https://tracker.example.com/T-2" }] },
    }];

    expect(match(events, "https://tracker.example.com/T-2")).toBeUndefined();
  });

  it("pairs a result with its call by the call's tool_use_id, as the Pi translator records it", () => {
    const events: ProvenanceEvent[] = [
      { id: "sevt_server_assigned", type: "agent.tool_use", processed_at: at(0), payload: { name: "web_search", input: { query: "q" }, tool_use_id: "toolu_pi_1" } },
      { id: id(), type: "agent.tool_result", processed_at: at(0), payload: { tool_use_id: "toolu_pi_1", is_error: false, content: JSON.stringify([{ source: "https://docs.example.com/z" }]) } },
    ];

    expect(match(events, "https://docs.example.com/z")?.kind).toBe("exact");
  });

  it("keeps ] and } that are part of a URL", () => {
    const shown = shownUrls([userMessage("https://docs.example.com/send?value=abc]secret")], new Date(T0));

    expect([
      matchShownUrl("https://docs.example.com/send?value=abc]secret", shown)?.kind,
      matchShownUrl("https://docs.example.com/send?value=abc", shown),
    ]).toEqual(["exact", undefined]);
  });

  it("reads a relative link with balanced parentheses in full", () => {
    const events = fetchedPage("sevt_f9", "https://docs.example.com/", "See [page](guide_(advanced)).");
    const shown = shownUrls(events, new Date(T0 + 60_000));

    expect([
      matchShownUrl("https://docs.example.com/guide_(advanced)", shown)?.kind,
      matchShownUrl("https://docs.example.com/guide_(advanced", shown),
    ]).toEqual(["exact", undefined]);
  });
});
