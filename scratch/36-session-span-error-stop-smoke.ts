/**
 * Smoke 36 — deterministic control-plane smoke for Pi stopReason:"error".
 *
 * This does not call Anthropic. It drives the public OMA HTTP app with a
 * RuntimeEventRunner that emits Pi's documented model-error shape and verifies
 * event replay exposes a linked span.model_request_end with is_error=true.
 *
 * Run from the repo root:
 *   npx tsx scratch/36-session-span-error-stop-smoke.ts
 */

import { createInMemoryControlPlaneApp } from "../src/control-plane/app.ts";
import type { RuntimeEventRunner } from "../src/control-plane/events/types.ts";

const betaHeaders = {
  "anthropic-beta": "managed-agents-2026-04-01",
  "content-type": "application/json",
};

class ErrorStopReasonRunner implements RuntimeEventRunner {
  async *runUserMessage(): AsyncIterable<unknown> {
    await Promise.resolve();
    yield {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    };
    yield {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        usage: { input: 31, output: 0, cacheRead: 11, cacheWrite: 13 },
        stopReason: "error",
        errorMessage: "forced provider failure",
      },
    };
  }
}

const app = createInMemoryControlPlaneApp({
  runtime: {
    runner: new ErrorStopReasonRunner(),
    translate: () => [],
  },
});

async function requestJson(path: string, body: unknown): Promise<any> {
  const res = await app.request(path, {
    method: "POST",
    headers: betaHeaders,
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

const agent = await requestJson("/v1/agents", {
  name: "forced error span smoke",
  model: "claude-opus-4-7",
  tools: [],
});
const env = await requestJson("/v1/environments", {
  name: "forced-error-span",
  config: { type: "cloud", networking: { type: "unrestricted" } },
});
const session = await requestJson("/v1/sessions", {
  agent: agent.id,
  environment_id: env.id,
});
await requestJson(`/v1/sessions/${session.id}/events`, {
  events: [
    {
      type: "user.message",
      content: [{ type: "text", text: "force an error stop reason" }],
    },
  ],
});

const startedAt = Date.now();
let listed: any = null;
while (Date.now() - startedAt < 5_000) {
  const res = await app.request(`/v1/sessions/${session.id}/events?order=asc`, {
    headers: betaHeaders,
  });
  if (res.status !== 200) throw new Error(`list failed: ${res.status}`);
  listed = await res.json();
  if (listed.data.some((event: any) => event.type === "span.model_request_end")) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
}

const replayTypes = listed.data.map((event: any) => event.type);
const start = listed.data.find((event: any) => event.type === "span.model_request_start");
const end = listed.data.find((event: any) => event.type === "span.model_request_end");
const pass =
  replayTypes.join(",") ===
    "user.message,span.model_request_start,span.model_request_end" &&
  end?.model_request_start_id === start?.id &&
  end?.is_error === true &&
  end?.model_usage?.input_tokens === 31 &&
  end?.model_usage?.cache_read_input_tokens === 11 &&
  end?.model_usage?.cache_creation_input_tokens === 13;

console.log(
  JSON.stringify(
    {
      pass,
      replay_types: replayTypes,
      span_start_id: start?.id,
      span_end_start_id: end?.model_request_start_id,
      span_end_is_error: end?.is_error,
      span_end_usage: end?.model_usage,
    },
    null,
    2,
  ),
);

if (!pass) process.exit(1);
