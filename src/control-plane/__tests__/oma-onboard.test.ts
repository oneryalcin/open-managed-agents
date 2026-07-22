import { describe, expect, it, vi } from "vitest";
import {
  ONBOARD_CANCELLED,
  runOnboard,
  type OnboardRuntime,
  type OnboardTerminal,
} from "../../../scripts/oma-onboard.ts";

function readyReport() {
  return {
    schema_version: 1 as const,
    ok: true,
    checks: [
      { id: "node.version", status: "pass" as const, summary: "Node ready" },
      { id: "models.catalog", status: "pass" as const, summary: "Catalog ready" },
      { id: "sandbox.runtime", status: "pass" as const, summary: "Docker ready" },
      { id: "sandbox.image", status: "pass" as const, summary: "Image ready" },
      { id: "server.port", status: "pass" as const, summary: "Port ready" },
    ],
  };
}

function terminal(overrides: Partial<OnboardTerminal> = {}): OnboardTerminal {
  return {
    intro: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), outro: vi.fn(), cancel: vi.fn(),
    select: vi.fn(async () => "anthropic"),
    confirm: vi.fn(async () => true),
    password: vi.fn(async () => "secret-value"),
    ...overrides,
  };
}

function runtime(overrides: Partial<OnboardRuntime> = {}): OnboardRuntime {
  return {
    env: {},
    interactive: true,
    terminal: terminal(),
    inspect: vi.fn(async () => readyReport()),
    providerStatus: vi.fn(async (provider?: string) => ({ providers: ["anthropic", "openai"], stored: provider === undefined ? undefined : false })),
    storeCredential: vi.fn(async () => {}),
    readStdin: vi.fn(async () => "secret-from-stdin"),
    ...overrides,
  };
}

describe("oma onboard foundation", () => {
  it("preflights before it prompts for or stores a credential", async () => {
    const storeCredential = vi.fn(async () => {});
    const prompt = vi.fn(async () => "should-not-be-read");
    const failing = runtime({
      terminal: terminal({ password: prompt }),
      inspect: vi.fn(async () => ({ ...readyReport(), ok: false, checks: [
        ...readyReport().checks.filter((check) => check.id !== "sandbox.image"),
        { id: "sandbox.image", status: "warn" as const, summary: "Image missing" },
      ] })),
      storeCredential,
    });

    const result = await runOnboard(["--provider", "anthropic"], failing);

    expect(result.code).toBe(1);
    expect(prompt).not.toHaveBeenCalled();
    expect(storeCredential).not.toHaveBeenCalled();
    expect(JSON.stringify((failing.terminal.error as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("secret");
  });

  it("stores a masked-prompt credential only after preflight passes", async () => {
    const storeCredential = vi.fn(async () => {});
    const result = await runOnboard(["--provider", "anthropic"], runtime({ storeCredential }));

    expect(result).toMatchObject({ code: 0, provider: "anthropic", credential: "stored" });
    expect(storeCredential).toHaveBeenCalledWith("anthropic", "secret-value");
  });

  it("does not reject the intentionally uninspected microsandbox image", async () => {
    const storeCredential = vi.fn(async () => {});
    const report = {
      ...readyReport(),
      checks: [
        ...readyReport().checks.filter((check) => check.id !== "sandbox.image"),
        { id: "sandbox.image", status: "warn" as const, summary: "Image intentionally not inspected" },
      ],
    };

    const result = await runOnboard(
      ["--provider", "anthropic", "--sandbox", "microsandbox"],
      runtime({ inspect: vi.fn(async () => report), storeCredential }),
    );

    expect(result.code).toBe(0);
    expect(storeCredential).toHaveBeenCalledOnce();
  });

  it("reuses an existing credential without reading a secret", async () => {
    const prompt = vi.fn(async () => "should-not-be-read");
    const storeCredential = vi.fn(async () => {});
    const result = await runOnboard(["--provider", "anthropic"], runtime({
      terminal: terminal({ password: prompt, confirm: vi.fn(async () => true) }),
      providerStatus: vi.fn(async (provider?: string) => ({ providers: ["anthropic"], stored: provider === undefined ? undefined : true })),
      storeCredential,
    }));

    expect(result.credential).toBe("reused");
    expect(prompt).not.toHaveBeenCalled();
    expect(storeCredential).not.toHaveBeenCalled();
  });

  it("fails fast on a non-interactive invocation without explicit credential input", async () => {
    const inspect = vi.fn(async () => readyReport());
    const result = await runOnboard([], runtime({ interactive: false, inspect }));

    expect(result.code).toBe(2);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("keeps parse failures machine-readable when JSON output was requested", async () => {
    const errors: string[] = [];
    const result = await runOnboard(["--json", "--unknown"], runtime({
      terminal: terminal({ error: (message) => errors.push(message) }),
    }));

    expect(result.code).toBe(2);
    expect(errors).toEqual([]);
  });

  it("cancels without storing a credential", async () => {
    const storeCredential = vi.fn(async () => {});
    const cancelPassword: OnboardTerminal["password"] = async () => ONBOARD_CANCELLED;
    const result = await runOnboard(["--provider", "anthropic"], runtime({
      terminal: terminal({ password: cancelPassword }),
      storeCredential,
    }));

    expect(result.code).toBe(130);
    expect(storeCredential).not.toHaveBeenCalled();
  });
});
