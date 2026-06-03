import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { translatePiEvent, type EventDraft } from "../translator.ts";
import {
  spanModelRequestEndDraft,
  spanModelRequestStartDraft,
} from "../span-normalizer.ts";

type Scenario = "simple_message" | "tool_call" | "abort";

describe("Pi span normalizer", () => {
  it("wraps a simple assistant response in a model request span", () => {
    const drafts = normalizeScenario("simple_message");

    expect(types(drafts)).toEqual([
      "session.status_running",
      "span.model_request_start",
      "agent.message",
      "span.model_request_end",
      "session.status_idle",
    ]);
    expect(drafts[3]?.payload).toMatchObject({
      model_request_start_id: "sevt_span_1",
      is_error: false,
      model_usage: {
        cache_creation_input_tokens: expect.any(Number),
        cache_read_input_tokens: expect.any(Number),
        input_tokens: expect.any(Number),
        output_tokens: expect.any(Number),
        speed: null,
      },
    });
  });

  it("emits one span pair around tool choice and another around final text", () => {
    const drafts = normalizeScenario("tool_call");

    expect(types(drafts)).toEqual([
      "session.status_running",
      "span.model_request_start",
      "agent.tool_use",
      "span.model_request_end",
      "agent.tool_result",
      "span.model_request_start",
      "agent.message",
      "span.model_request_end",
      "session.status_idle",
    ]);
    expect(drafts[3]?.payload.model_request_start_id).toBe("sevt_span_1");
    expect(drafts[7]?.payload.model_request_start_id).toBe("sevt_span_2");
  });

  it("closes an aborted assistant request with an error span end", () => {
    const drafts = normalizeScenario("abort");

    expect(types(drafts)).toEqual([
      "session.status_running",
      "span.model_request_start",
      "agent.tool_use",
      "span.model_request_end",
      "agent.tool_result",
      "span.model_request_start",
      "span.model_request_end",
      "session.status_idle",
    ]);
    expect(drafts[6]?.payload).toMatchObject({
      model_request_start_id: "sevt_span_2",
      is_error: true,
      model_usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        speed: null,
      },
    });
  });

  it("marks Pi model error stop reasons as error span ends", () => {
    const endDrafts = spanModelRequestEndDraft(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          usage: {
            input: 23,
            output: 0,
            cacheRead: 19,
            cacheWrite: 17,
          },
          stopReason: "error",
          errorMessage: "provider failed",
        },
      },
      "sevt_model_start",
    );

    expect(endDrafts).toHaveLength(1);
    expect(endDrafts[0]?.payload).toMatchObject({
      model_request_start_id: "sevt_model_start",
      is_error: true,
      model_usage: {
        cache_creation_input_tokens: 17,
        cache_read_input_tokens: 19,
        input_tokens: 23,
        output_tokens: 0,
        speed: null,
      },
    });
  });

  it("passes through Pi model speed when available", () => {
    const endDrafts = spanModelRequestEndDraft(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          speed: "fast",
          usage: {
            input: 1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 4,
          },
          stopReason: "stop",
        },
      },
      "sevt_model_start",
    );

    expect(endDrafts[0]?.payload.model_usage).toMatchObject({
      speed: "fast",
    });
  });
});

function normalizeScenario(scenario: Scenario): EventDraft[] {
  const lines = loadScenarioLines(scenario);
  const out: EventDraft[] = [];
  const openStartIds: string[] = [];
  let nextSpan = 1;

  for (const line of lines) {
    const startDrafts = spanModelRequestStartDraft(line.event);
    const transcriptDrafts = translatePiEvent(line.event);
    const closingStartId = openStartIds[openStartIds.length - 1];
    const endDrafts = spanModelRequestEndDraft(line.event, closingStartId);
    out.push(...startDrafts, ...transcriptDrafts, ...endDrafts);
    if (startDrafts.length > 0) {
      openStartIds.push(`sevt_span_${nextSpan}`);
      nextSpan += 1;
    }
    if (endDrafts.length > 0) openStartIds.pop();
  }

  return out;
}

function loadScenarioLines(
  scenario: Scenario,
): Array<{ scenario: Scenario; seq: number; captured_at: string; event: unknown }> {
  const path = join(process.cwd(), "scratch", "artifacts", "pi-events", `${scenario}.jsonl`);
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line));
}

function types(drafts: EventDraft[]): string[] {
  return drafts.map((d) => d.type);
}
