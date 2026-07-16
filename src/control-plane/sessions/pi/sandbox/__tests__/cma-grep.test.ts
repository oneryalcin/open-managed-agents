import { describe, expect, it } from "vitest";
import {
  CmaGrepStreamCollector,
  assertCmaGrepContext,
  assertCmaGrepHeadLimit,
  assertCmaGrepPath,
  assertCmaGrepPattern,
} from "../cma-grep.ts";

describe("CMA grep helpers", () => {
  it("validates public input bounds", () => {
    expect(assertCmaGrepPattern("x")).toBe("x");
    expect(() => assertCmaGrepPattern("")).toThrow("required");
    expect(() => assertCmaGrepPattern("x".repeat(4_097))).toThrow("4096 bytes");
    expect(assertCmaGrepPath("/workspace")).toBe("/workspace");
    expect(() => assertCmaGrepPath("relative")).toThrow("absolute");
    expect(assertCmaGrepContext(undefined)).toBe(0);
    expect(assertCmaGrepContext(100)).toBe(100);
    expect(() => assertCmaGrepContext(101)).toThrow("0 through 100");
    expect(assertCmaGrepHeadLimit(undefined)).toBe(100);
    expect(assertCmaGrepHeadLimit(100)).toBe(100);
    expect(() => assertCmaGrepHeadLimit(0)).toThrow("1 through 100");
  });

  it("enforces output and match limits exactly", () => {
    const stopped: boolean[] = [];
    const collector = new CmaGrepStreamCollector({
      root: "/workspace",
      maxMatches: 1,
      maxRawBytes: Buffer.byteLength("./a.md\0./b.md\0"),
      maxOutputBytes: Buffer.byteLength("/workspace/a.md"),
      join: (root, relativePath) => `${root}/${relativePath}`,
      onLimit: () => stopped.push(true),
    });
    collector.push(Buffer.from("./a.md\0./b.md\0"));
    collector.finish();
    expect(collector.matches).toEqual(["/workspace/a.md"]);
    expect(stopped).toEqual([true]);

    const outputBounded = new CmaGrepStreamCollector({
      root: "/workspace",
      maxMatches: 100,
      maxRawBytes: 100,
      maxOutputBytes: 3,
      join: (root, relativePath) => `${root}/${relativePath}`,
      onLimit: () => undefined,
    });
    expect(() => outputBounded.push(Buffer.from("./a.md\0"))).toThrow("output exceeds");

    const absolute = new CmaGrepStreamCollector({
      root: "/mnt/session/uploads",
      maxMatches: 100,
      maxRawBytes: 100,
      maxOutputBytes: 100,
      join: (root, relativePath) => `${root}/${relativePath}`,
      onLimit: () => undefined,
    });
    absolute.push(Buffer.from("/mnt/session/uploads/data/probe.txt\0"));
    absolute.finish();
    expect(absolute.matches).toEqual(["/mnt/session/uploads/data/probe.txt"]);
  });
});
