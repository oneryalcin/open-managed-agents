import { describe, expect, it } from "vitest";
import { createInMemoryControlPlaneApp } from "./helpers.ts";
import { listEvents, sendMessage, setupSession, waitFor } from "./api-helpers.ts";
import type { WebFetchOptions, WebFetchResult } from "../egress/guarded-fetch.ts";
import { parseNetworkingConfig, type EgressPolicy } from "../egress/policy.ts";
import { PiSessionRunner } from "../sessions/pi/runner.ts";
import { translatePiEvent } from "../sessions/pi/translator.ts";
import { createRealPi } from "../sessions/pi/__tests__/real-pi.ts";
import type { BuiltinToolPermission } from "../sessions/pi/tool-permissions.ts";

// Plan 0149 slice 1d: web_fetch end to end through a real Pi session (faux
// model): registration, the permission gate, the builtin event flow, the
// translator, and the persisted events. The network is faked; the guarded
// fetch is tested against real servers in egress/__tests__.

const policy = parseNetworkingConfig({
  networking: { type: "limited", allowed_hosts: ["docs.example.com"] },
}) as EgressPolicy;

const PAGE = "<html><head><title>Guide</title></head><body><h1>Install</h1><p>Run it.</p></body></html>";

async function scenario(opts: { url: string; prompt: string; permission?: BuiltinToolPermission }) {
  const pi = await createRealPi();
  pi.core.setResponses([
    pi.faux.fauxAssistantMessage([pi.faux.fauxToolCall("web_fetch", { url: opts.url })], { stopReason: "toolUse" }),
    pi.faux.fauxAssistantMessage("done"),
  ]);
  const fetched: string[] = [];
  const fetchResource = async (url: string, options: WebFetchOptions): Promise<WebFetchResult> => {
    fetched.push(url);
    const check = options.validate(url);
    if (!check.ok) return { ok: false, code: check.code, reason: check.reason, url };
    return { ok: true, finalUrl: url, status: 200, contentType: "text/html", body: new TextEncoder().encode(PAGE), truncated: false };
  };
  let app!: ReturnType<typeof createInMemoryControlPlaneApp>;
  const runner = new PiSessionRunner({
    modelCatalog: pi.modelCatalog,
    builtinToolAccess: (_ws, _sid, toolName) =>
      toolName === "web_fetch"
        ? { enabled: true, permission: opts.permission ?? "allow" }
        : { enabled: false, permission: "deny" },
    webTools: {
      context: async (_ws, sessionId) => ({
        policy,
        events: (await listEvents(app, sessionId)).map((event) => ({
          id: String(event.id),
          type: String(event.type),
          processed_at: (event.processed_at as string | null) ?? null,
          payload: event,
        })),
      }),
      fetchResource,
    },
  });
  app = createInMemoryControlPlaneApp({ runtime: { runner, translate: translatePiEvent } });
  const session = await setupSession(app);
  await sendMessage(app, session.id, opts.prompt);
  return { app, session, fetched };
}

const typesOf = (events: Array<Record<string, unknown>>) => events.map((event) => event.type);

describe("web_fetch through a real Pi session", () => {
  it("records the call and hosted's document result for a shown URL", async () => {
    const { app, session } = await scenario({
      url: "https://docs.example.com/guide",
      prompt: "read https://docs.example.com/guide",
    });
    await waitFor(async () => typesOf(await listEvents(app, session.id)).includes("session.status_idle"));

    const events = await listEvents(app, session.id);
    const result = events.find((event) => event.type === "agent.tool_result");

    expect(result?.content).toEqual([{
      type: "document", title: "Guide", context: null,
      source: { type: "text", media_type: "text/plain", data: "# Install\n\nRun it." },
    }]);
  });

  it("publishes one agent.tool_use named web_fetch with the URL", async () => {
    const { app, session } = await scenario({
      url: "https://docs.example.com/guide",
      prompt: "read https://docs.example.com/guide",
    });
    await waitFor(async () => typesOf(await listEvents(app, session.id)).includes("session.status_idle"));

    const uses = (await listEvents(app, session.id)).filter((event) => event.type === "agent.tool_use");

    expect(uses.map((use) => [use.name, use.input])).toEqual([["web_fetch", { url: "https://docs.example.com/guide" }]]);
  });

  it("refuses a URL the conversation never showed, without fetching", async () => {
    const { app, session, fetched } = await scenario({
      url: "https://docs.example.com/secret",
      prompt: "read the docs",
    });
    await waitFor(async () => typesOf(await listEvents(app, session.id)).includes("session.status_idle"));

    const result = (await listEvents(app, session.id)).find((event) => event.type === "agent.tool_result");

    expect([result?.is_error, JSON.stringify(result?.content).includes("url_not_in_prior_context"), fetched]).toEqual([true, true, []]);
  });

  it("waits for confirmation under always_ask before fetching", async () => {
    const { app, session, fetched } = await scenario({
      url: "https://docs.example.com/guide",
      prompt: "read https://docs.example.com/guide",
      permission: "ask",
    });
    await waitFor(async () =>
      (await listEvents(app, session.id)).some(
        (event) => event.type === "session.status_idle" &&
          (event.stop_reason as { type?: string } | undefined)?.type === "requires_action",
      ),
    );

    expect(fetched).toEqual([]);
  });
});
