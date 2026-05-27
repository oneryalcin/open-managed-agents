import { describe, expect, it } from "vitest";
import { PiCustomToolBridge } from "../custom-tools.ts";

const CUSTOM_TOOL = {
  type: "custom" as const,
  name: "ask_user",
  description: "Ask the user.",
  input_schema: {
    type: "object",
    properties: { question: { type: "string" } },
  },
};

describe("PiCustomToolBridge", () => {
  it("cleans a bound pending call if public event persistence fails", async () => {
    const bridge = new PiCustomToolBridge({
      customTools: () => [CUSTOM_TOOL],
      timeoutMs: 0,
    });
    let released = 0;
    const [tool] = bridge.createTools("wrk_default", "sesn_bridge", () => (event) => {
      event.bindCustomToolUseId("sevt_bound_then_failed", () => {
        released += 1;
      });
      event.rejectCustomToolUse(new Error("persist failed"));
    });

    await expect(
      tool?.execute(
        "toolu_pi",
        { question: "q" },
        new AbortController().signal,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("persist failed");

    expect(
      bridge.claimResult("wrk_default", "sesn_bridge", {
        type: "user.custom_tool_result",
        custom_tool_use_id: "sevt_bound_then_failed",
      }),
    ).toBeUndefined();
    expect(released).toBe(1);
  });

  it("times out if the runtime service never binds a public event ID", async () => {
    const bridge = new PiCustomToolBridge({
      customTools: () => [CUSTOM_TOOL],
      timeoutMs: 1,
    });
    const [tool] = bridge.createTools("wrk_default", "sesn_bridge", () => () => {});

    await expect(
      tool?.execute(
        "toolu_pi",
        { question: "q" },
        new AbortController().signal,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("timed out");
  });

  it("clears a pending call when Pi aborts the tool execution signal", async () => {
    const bridge = new PiCustomToolBridge({
      customTools: () => [CUSTOM_TOOL],
      timeoutMs: 0,
    });
    let released = 0;
    const [tool] = bridge.createTools("wrk_default", "sesn_bridge", () => (event) => {
      event.bindCustomToolUseId("sevt_abort", () => {
        released += 1;
      });
    });
    const ac = new AbortController();
    const result = tool?.execute(
      "toolu_pi",
      { question: "q" },
      ac.signal,
      undefined,
      {} as never,
    );

    ac.abort();

    await expect(result).rejects.toThrow("aborted");
    expect(
      bridge.claimResult("wrk_default", "sesn_bridge", {
        type: "user.custom_tool_result",
        custom_tool_use_id: "sevt_abort",
      }),
    ).toBeUndefined();
    expect(released).toBe(1);
  });

  it("throws when the API caller marks a custom tool result as an error", async () => {
    const bridge = new PiCustomToolBridge({
      customTools: () => [CUSTOM_TOOL],
      timeoutMs: 0,
    });
    let boundId: string | undefined;
    const [tool] = bridge.createTools("wrk_default", "sesn_bridge", () => (event) => {
      event.bindCustomToolUseId("sevt_error", () => {});
      boundId = "sevt_error";
    });
    const result = tool?.execute(
      "toolu_pi",
      { question: "q" },
      new AbortController().signal,
      undefined,
      {} as never,
    );
    const commit = bridge.claimResult("wrk_default", "sesn_bridge", {
      type: "user.custom_tool_result",
      custom_tool_use_id: boundId as string,
      content: [{ type: "text", text: "external failure" }],
      is_error: true,
    });

    commit?.();

    await expect(result).rejects.toThrow("external failure");
    expect(
      bridge.claimResult("wrk_default", "sesn_bridge", {
        type: "user.custom_tool_result",
        custom_tool_use_id: "sevt_error",
      }),
    ).toBeUndefined();
  });
});
