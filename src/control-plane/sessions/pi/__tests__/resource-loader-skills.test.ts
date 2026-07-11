import { describe, expect, it } from "vitest";
import { buildSessionSkillsResourceLoader } from "../runner.ts";

// Pins the real Pi 0.80.6 DefaultResourceLoader contract the runner depends on:
// skillsOverride only runs inside reload(), so getSkills() is empty until then.
// The mocked runner test cannot prove this against the real SDK; a Pi upgrade
// that changed the contract would silently break skill delivery to the model,
// so exercise the exact loader the runner builds, un-mocked.
describe("session skills resource loader (real Pi SDK)", () => {
  it("advertises no skills before reload and the mounted skill after reload", async () => {
    const loader = buildSessionSkillsResourceLoader([
      { name: "demo-skill", description: "Use the demo" },
    ]);

    expect(loader.getSkills().skills).toEqual([]);

    await loader.reload();

    const skills = loader.getSkills().skills;
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "demo-skill",
      filePath: "/workspace/skills/demo-skill/SKILL.md",
      baseDir: "/workspace/skills/demo-skill",
    });
  });
});
