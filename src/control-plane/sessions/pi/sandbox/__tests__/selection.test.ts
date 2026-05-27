import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseSandboxProviderSelection,
  resolveSandboxProviderFactory,
} from "../selection.ts";

describe("sandbox provider selection (Cycle E.3)", () => {
  it("parses none as no builtin execution provider", () => {
    const selection = parseSandboxProviderSelection({ type: "none" });

    expect(selection).toEqual({ type: "none" });
    expect(resolveSandboxProviderFactory(selection)).toBeUndefined();
  });

  it("rejects unknown, misspelled, and malformed runtime JSON", () => {
    expect(() =>
      parseSandboxProviderSelection({ type: "dokcer-local" }),
    ).toThrow("Unsupported sandbox provider type");
    expect(() =>
      parseSandboxProviderSelection({
        type: "docker-local",
        envAllowlist: "PATH",
      }),
    ).toThrow("`envAllowlist` must be an array of strings");
    expect(() =>
      parseSandboxProviderSelection({
        type: "docker-local",
        unsafeAllowHostPassthrough: true,
      }),
    ).toThrow("`unsafeAllowHostPassthrough` is only valid");
    expect(() =>
      parseSandboxProviderSelection({
        type: "none",
        unsafeAllowHostPassthrough: true,
      }),
    ).toThrow("Unsupported sandbox provider field");
  });

  it("requires both deployment and per-session gates for host passthrough", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "oma-selection-"));
    try {
      const selection = parseSandboxProviderSelection({
        type: "host-passthrough",
        unsafeAllowHostPassthrough: true,
        envAllowlist: ["PATH"],
      });

      expect(() =>
        resolveSandboxProviderFactory(selection, {
          hostPassthroughWorkspaceRoot: workspaceRoot,
        }),
      ).toThrow("disabled by deployment configuration");

      const factory = resolveSandboxProviderFactory(selection, {
        allowUnsafeHostPassthrough: true,
        hostPassthroughWorkspaceRoot: workspaceRoot,
      });
      const provider = await factory?.("wrk", "sesn");
      expect(provider?.toolNames.has("bash")).toBe(true);
      provider?.dispose();
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("rechecks the per-session host gate in the resolver", () => {
    expect(() =>
      resolveSandboxProviderFactory(
        { type: "host-passthrough" } as never,
        {
          allowUnsafeHostPassthrough: true,
          hostPassthroughWorkspaceRoot: "/tmp",
        },
      ),
    ).toThrow("`unsafeAllowHostPassthrough` must be true");
  });

  it("keeps docker-local disabled unless deployment config allows it", () => {
    const selection = parseSandboxProviderSelection({
      type: "docker-local",
      envAllowlist: ["PATH"],
      operationTimeoutMs: 1000,
    });

    expect(() => resolveSandboxProviderFactory(selection)).toThrow(
      "disabled by deployment configuration",
    );

    expect(
      resolveSandboxProviderFactory(selection, {
        allowDockerLocal: true,
      }),
    ).toBeTypeOf("function");
  });
});
