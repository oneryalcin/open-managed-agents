import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("alpha onboarding documentation contract", () => {
  it("keeps one canonical source-checkout flow as the linked advanced guide", () => {
    const guide = read("docs/getting-started.md");
    const readme = read("README.md");
    const index = read("docs/index.md");
    for (const anchor of [
      "npm ci",
      "oma doctor",
      "oma smoke --local-compatible",
      "oma smoke --egress",
      "oma up",
      "Workspace",
      "Create an agent",
      "Create an environment",
      "Create a session",
    ]) expect(guide, anchor).toContain(anchor);
    expect(readme.slice(0, 5000)).toContain("https://github.com/oneryalcin/open-managed-agents/blob/main/docs/getting-started.md");
    expect(index.slice(0, 2200)).toContain("getting-started.md");
  });

  it("documents approved HTTPS as an explicit immutable environment choice", () => {
    const guide = read("docs/getting-started.md");
    const readme = read("README.md");
    const deployment = read("docs/dev-deployment.md");
    const dockerTutorial = read("docs/tutorials/docker-local-first-run.md");
    const publicDocs = `${guide}\n${readme}\n${deployment}\n${dockerTutorial}`;
    for (const statement of [
      "Offline",
      "npm + PyPI",
      "GitHub + package registries",
      "Custom",
      "offline by default",
      "oma smoke --egress",
      "Microsandbox-local remains offline-only",
    ]) expect(publicDocs, statement).toContain(statement);
    expect(publicDocs).toContain("does not include `example.com`");
    expect(publicDocs).toMatch(/immutable|cannot be edited/);
    expect(publicDocs).not.toMatch(/unrestricted networking (?:is|becomes) available/i);
  });

  it("advertises the shipped npm entrypoint without inventing other installers", () => {
    const guide = read("docs/getting-started.md");
    const readme = read("README.md");
    const dockerTutorial = read("docs/tutorials/docker-local-first-run.md");
    expect(`${guide}\n${readme}`).not.toMatch(/curl[^\n]+\|\s*(?:sh|bash)/);
    expect(`${guide}\n${readme}`).not.toMatch(/brew install/);
    expect(guide).not.toMatch(/npx .*open-managed-agents/);
    expect(readme.slice(0, 5000)).toContain("npx --yes open-managed-agents@latest");
    expect(dockerTutorial).not.toMatch(/primary|recommended/i);
    expect(dockerTutorial).toContain("getting-started.md");
  });

  it("keeps the public warm-path gate honest and source checkout diagnostic", () => {
    const observation = read("docs/references/alpha-onboarding-observation.md");
    const alpha = read("ALPHA.md");
    const handoff = read("handoff.md");
    expect(observation).toContain("Status: not run yet");
    expect(observation).toContain("npx --yes open-managed-agents@latest");
    expect(observation).toContain("180 seconds");
    expect(observation).toContain("at least three non-maintainer");
    expect(observation).toContain("Cold Image");
    expect(observation).toContain("Source Checkout");
    expect(observation).toContain("undocumented intervention");
    expect(`${alpha}\n${handoff}`).toContain("#196");
    expect(`${alpha}\n${handoff}`).toContain("0.1.2");
  });
});
