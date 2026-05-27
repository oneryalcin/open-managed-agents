import { describe, expect, it } from "vitest";
import { matchGlob, toPosix } from "../glob.ts";

describe("sandbox glob matcher", () => {
  const files = [
    "README.md",
    "src/index.ts",
    "src/control/provider.ts",
    "src/control/provider.test.ts",
    "docs/guide.md",
    "node_modules/pkg/index.ts",
    ".git/config",
    "packages/app/package.json",
  ];

  it("matches exact paths and basename fallbacks", () => {
    expect(matchGlob(files, "README.md")).toEqual(["README.md"]);
    expect(matchGlob(files, "*.md")).toEqual(["README.md", "docs/guide.md"]);
  });

  it("supports recursive double-star patterns", () => {
    expect(matchGlob(files, "**/*.ts")).toEqual([
      "src/index.ts",
      "src/control/provider.ts",
      "src/control/provider.test.ts",
      "node_modules/pkg/index.ts",
    ]);
  });

  it("applies ignores before matching and limiting", () => {
    expect(
      matchGlob(files, "**/*.ts", {
        ignore: ["**/node_modules/**", "**/*.test.ts"],
        limit: 2,
      }),
    ).toEqual(["src/index.ts", "src/control/provider.ts"]);
  });

  it("normalizes Windows separators before matching", () => {
    expect(toPosix("src\\control\\provider.ts")).toBe(
      "src/control/provider.ts",
    );
    expect(matchGlob(["src\\control\\provider.ts"], "**/*.ts")).toEqual([
      "src\\control\\provider.ts",
    ]);
  });
});
