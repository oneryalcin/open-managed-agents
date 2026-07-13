import { describe, expect, it } from "vitest";
import {
  CMA_GLOB_READY_MARKER,
  CmaGlobPatternError,
  CmaGlobReadinessFilter,
  CmaGlobStreamCollector,
  compileCmaGlob,
} from "../cma-glob.ts";

describe("CMA glob pattern compiler", () => {
  it("requires a correlated readiness record before filename streaming", () => {
    const filter = new CmaGlobReadinessFilter(CMA_GLOB_READY_MARKER);
    expect(filter.push(Buffer.from("__OMA_GLOB_"))).toBeUndefined();
    expect(filter.push(Buffer.from("READY__\0a.md\0"))?.toString()).toBe("a.md\0");
    expect(() => filter.assertReady()).not.toThrow();
    expect(() => new CmaGlobReadinessFilter(CMA_GLOB_READY_MARKER).assertReady())
      .toThrow("did not publish readiness");
    expect(() => new CmaGlobReadinessFilter(CMA_GLOB_READY_MARKER)
      .push(Buffer.from("wrong\0"))).toThrow("Invalid glob readiness marker");
  });
  it("matches the hosted recursive wildcard grammar", () => {
    const markdown = compileCmaGlob("*.md");
    expect(markdown.matches("a.md")).toBe(true);
    expect(markdown.matches("nested/deeper/a.md")).toBe(true);
    expect(markdown.matches("a.txt")).toBe(false);

    const recursive = compileCmaGlob("**/*.md");
    expect(recursive.matches("a.md")).toBe(true);
    expect(recursive.matches("nested/a.md")).toBe(true);
  });

  it("supports question marks, classes, ranges, braces, and escapes", () => {
    expect(compileCmaGlob("?.md").matches("a.md")).toBe(true);
    expect(compileCmaGlob("[ab].md").matches("b.md")).toBe(true);
    expect(compileCmaGlob("[a-c].md").matches("c.md")).toBe(true);
    expect(compileCmaGlob("{a,b}.md").matches("b.md")).toBe(true);
    expect(compileCmaGlob("q\\?.md").matches("q?.md")).toBe(true);
    expect(compileCmaGlob("\\[literal\\].md").matches("[literal].md")).toBe(true);
    expect(compileCmaGlob("😀.md").matches("😀.md")).toBe(true);
    expect(compileCmaGlob("[!a].md").matches("b.md")).toBe(true);
    expect(compileCmaGlob("[!a].md").matches("a.md")).toBe(false);
    expect(compileCmaGlob("[a\\-c].md").matches("-.md")).toBe(true);
    expect(compileCmaGlob("[a\\-c].md").matches("b.md")).toBe(false);
    expect(compileCmaGlob("{a,{b,c}}.md").matches("c.md")).toBe(true);
    expect(compileCmaGlob("a\\\\b.md").matches("a\\b.md")).toBe(true);
  });

  it("keeps slash-sensitive wildcards while matching basenames recursively", () => {
    expect(compileCmaGlob("sub/*.md").matches("root/sub/a.md")).toBe(true);
    expect(compileCmaGlob("sub/*.md").matches("root/sub/deep/a.md")).toBe(false);
    expect(compileCmaGlob("sub/**").matches("root/sub/deep/a.md")).toBe(true);
  });

  it("rejects malformed and over-complex patterns", () => {
    for (const pattern of ["[", "]", "{a}", "{a,}", "\\", "[z-a]"]) {
      expect(() => compileCmaGlob(pattern), pattern).toThrow(CmaGlobPatternError);
    }
    expect(() => compileCmaGlob("a".repeat(1_024))).not.toThrow();
    expect(() => compileCmaGlob("a".repeat(1_025))).toThrow("1024 bytes");
    expect(() => compileCmaGlob(`[${"a".repeat(256)}]`)).not.toThrow();
    expect(() => compileCmaGlob(`[${"a".repeat(257)}]`)).toThrow("256 bytes");
    expect(() => compileCmaGlob("{{{{{a,b},c},d},e},f}")).toThrow("nesting exceeds 4");
    expect(() => compileCmaGlob(`{${Array.from({ length: 64 }, (_, i) => i).join(",")}}`))
      .not.toThrow();
    expect(() => compileCmaGlob(`{${Array.from({ length: 65 }, (_, i) => i).join(",")}}`))
      .toThrow("alternatives exceed 64");
    expect(() => compileCmaGlob(`${"{a,b}".repeat(6)}${"x".repeat(64)}`))
      .toThrow("compiled states exceed 4096");
  });

  it("parses NUL-framed filenames incrementally and stops at the match limit", () => {
    let stopped = 0;
    const collector = new CmaGlobStreamCollector(compileCmaGlob("*.md"), {
      root: "/workspace",
      maxMatches: 2,
      maxRawBytes: 1_024,
      maxOutputBytes: 1_024,
      join: (root, path) => `${root}/${path}`,
      onLimit: () => { stopped += 1; },
    });
    collector.push(Buffer.from("line\nname.md\0other"));
    collector.push(Buffer.from(".md\0ignored.md\0"));

    expect(collector.matches).toEqual([
      "/workspace/line\nname.md",
      "/workspace/other.md",
    ]);
    expect(collector.limitReached).toBe(true);
    expect(stopped).toBe(1);
  });

  it("keeps the match cap and stop callback stable after cancellation begins", () => {
    let stops = 0;
    const collector = new CmaGlobStreamCollector(compileCmaGlob("*.md"), {
      root: "/w",
      maxMatches: 1,
      maxRawBytes: 1_024,
      maxOutputBytes: 1_024,
      join: (root, path) => `${root}/${path}`,
      onLimit: () => { stops += 1; },
    });
    collector.push(Buffer.from("a.md\0b.md\0"));
    collector.push(Buffer.from("c.md\0"));

    expect(collector.matches).toEqual(["/w/a.md"]);
    expect(stops).toBe(1);
  });

  it("enforces distinct raw and formatted output byte ceilings", () => {
    const rawBounded = new CmaGlobStreamCollector(compileCmaGlob("*.md"), {
      root: "/w",
      maxMatches: 100,
      maxRawBytes: 4,
      maxOutputBytes: 1_024,
      join: (root, path) => `${root}/${path}`,
      onLimit: () => undefined,
    });
    expect(() => rawBounded.push(Buffer.from("12345"))).toThrow("raw bytes");

    const outputBounded = new CmaGlobStreamCollector(compileCmaGlob("*.md"), {
      root: "/workspace",
      maxMatches: 100,
      maxRawBytes: 1_024,
      maxOutputBytes: 10,
      join: (root, path) => `${root}/${path}`,
      onLimit: () => undefined,
    });
    expect(() => outputBounded.push(Buffer.from("a.md\0"))).toThrow("output exceeds");

    const relativeOutput = new CmaGlobStreamCollector(compileCmaGlob("*.md"), {
      root: "/very/long/internal/workspace",
      maxMatches: 100,
      maxRawBytes: 1_024,
      maxOutputBytes: 4,
      join: (root, path) => `${root}/${path}`,
      formatForOutput: (_absolute, relative) => relative,
      onLimit: () => undefined,
    });
    expect(() => relativeOutput.push(Buffer.from("a.md\0"))).not.toThrow();
  });

  it("handles long wildcard and deep-path inputs without recursive backtracking", () => {
    const matcher = compileCmaGlob("*a*a*a*a*a*a*a*a*a*b");
    expect(matcher.matches(`${"a".repeat(10_000)}b`)).toBe(true);
    expect(matcher.matches("a".repeat(10_000))).toBe(false);
    expect(compileCmaGlob("*.md").matches(`${"segment/".repeat(2_000)}target.md`)).toBe(true);
  });
});
