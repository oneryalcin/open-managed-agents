import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("alpha onboarding documentation contract", () => {
  it("keeps one canonical source-checkout flow and links it from the first README screen", () => {
    const guide = read("docs/getting-started.md");
    const readme = read("README.md");
    const index = read("docs/index.md");
    for (const anchor of [
      "npm ci",
      "oma doctor",
      "oma smoke --local-compatible",
      "oma up",
      "Workspace",
      "Create an agent",
      "Create an environment",
      "Create a session",
    ]) expect(guide, anchor).toContain(anchor);
    expect(readme.slice(0, 3000)).toContain("docs/getting-started.md");
    expect(index.slice(0, 2200)).toContain("getting-started.md");
  });

  it("does not advertise unshipped public installers or obsolete scratch scripts as onboarding", () => {
    const guide = read("docs/getting-started.md");
    const readme = read("README.md");
    const dockerTutorial = read("docs/tutorials/docker-local-first-run.md");
    expect(`${guide}\n${readme}`).not.toMatch(/curl[^\n]+\|\s*(?:sh|bash)/);
    expect(`${guide}\n${readme}`).not.toMatch(/brew install|npx open-managed-agents/);
    expect(dockerTutorial).not.toMatch(/primary|recommended/i);
    expect(dockerTutorial).toContain("getting-started.md");
  });

  it("keeps the human timing gate honest and distribution separately tracked", () => {
    const observation = read("docs/references/alpha-onboarding-observation.md");
    const alpha = read("ALPHA.md");
    const handoff = read("handoff.md");
    expect(observation).toContain("Status: not run yet");
    expect(observation).toContain("10 minutes");
    expect(observation).toContain("15 minutes");
    expect(observation).toContain("undocumented intervention");
    expect(`${alpha}\n${handoff}`).toContain("#196");
  });
});
