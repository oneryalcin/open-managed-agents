import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { translatePiEvent, type EventDraft } from "../translator.ts";

type Scenario = "simple_message" | "tool_call" | "tool_throw" | "abort";

describe("Pi translator (Cycle C.1)", () => {
  it("maps simple_message to assistant message + idle end_turn", () => {
    const drafts = translateScenario("simple_message");
    expect(types(drafts)).toEqual([
      "session.status_running",
      "agent.message",
      "session.status_idle",
    ]);
    const msg = drafts[1];
    expect(msg?.payload.content).toEqual([{ type: "text", text: "hello from probe-10" }]);
    const idle = drafts[2];
    expect(idle?.payload.stop_reason).toEqual({ type: "end_turn" });
  });

  it("maps tool_call to tool_use, tool_result, assistant message, then idle", () => {
    const drafts = translateScenario("tool_call");
    expect(types(drafts)).toEqual([
      "session.status_running",
      "agent.tool_use",
      "agent.tool_result",
      "agent.message",
      "session.status_idle",
    ]);
    expect(drafts[1]?.payload.tool_use_id).toEqual(expect.stringMatching(/^toolu_/));
    expect(drafts[1]?.payload.name).toBe("ask_me");
    expect(drafts[2]?.payload.tool_use_id).toBe(drafts[1]?.payload.tool_use_id);
    expect(drafts[2]?.payload.is_error).toBe(false);
    expect(drafts[3]?.payload.content).toEqual([
      { type: "text", text: "The phrase is: **PROBE_10_TOOL_CALL_OK**" },
    ]);
  });

  it("maps tool_throw to tool_use, error tool_result, assistant summary, then idle", () => {
    const drafts = translateScenario("tool_throw");
    expect(types(drafts)).toEqual([
      "session.status_running",
      "agent.message",
      "agent.tool_use",
      "agent.tool_result",
      "agent.message",
      "session.status_idle",
    ]);
    expect(drafts[3]?.payload.is_error).toBe(true);
    expect(drafts[3]?.payload.content).toEqual([
      { type: "text", text: "synthetic test error from probe-10" },
    ]);
    expect(drafts[4]?.payload.content).toEqual([
      expect.objectContaining({ type: "text" }),
    ]);
  });

  it("maps abort to tool_use, error tool_result, then idle", () => {
    const drafts = translateScenario("abort");
    expect(types(drafts)).toEqual([
      "session.status_running",
      "agent.tool_use",
      "agent.tool_result",
      "session.status_idle",
    ]);
    expect(drafts[2]?.payload.tool_use_id).toBe(drafts[1]?.payload.tool_use_id);
    expect(drafts[2]?.payload.is_error).toBe(true);
    expect(drafts[3]?.payload.stop_reason).toEqual({ type: "end_turn" });
  });

  it("keeps sandboxed builtin tools on the agent.tool_use/tool_result wire path", () => {
    const context = { customToolNames: new Set(["ask_user"]) };
    const drafts = [
      ...translatePiEvent(
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "toolu_builtin_bash",
                name: "bash",
                arguments: { command: "printf ok" },
              },
            ],
          },
        },
        context,
      ),
      ...translatePiEvent(
        {
          type: "tool_execution_end",
          toolCallId: "toolu_builtin_bash",
          toolName: "bash",
          result: { content: [{ type: "text", text: "ok" }] },
          isError: false,
        },
        context,
      ),
    ];

    expect(types(drafts)).toEqual(["agent.tool_use", "agent.tool_result"]);
    expect(drafts[0]?.payload.name).toBe("bash");
    expect(drafts[1]?.payload.tool_use_id).toBe("toolu_builtin_bash");
  });
});

function translateScenario(scenario: Scenario): EventDraft[] {
  const lines = loadScenarioLines(scenario);
  const out: EventDraft[] = [];
  for (const line of lines) {
    out.push(...translatePiEvent(line.event));
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
