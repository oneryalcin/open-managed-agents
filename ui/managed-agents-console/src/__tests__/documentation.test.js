import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const consoleRoot = fileURLToPath(new URL("..", import.meta.url));

function source(name) {
  return readFileSync(join(consoleRoot, name), "utf8");
}

describe("in-console documentation", () => {
  it("loads the Markdown-backed documentation reader before the app mounts", () => {
    const html = readFileSync(join(consoleRoot, "..", "index.html"), "utf8");
    expect(html.indexOf('src="src/docs.jsx"')).toBeGreaterThan(0);
    expect(html.indexOf('src="src/docs.jsx"')).toBeLessThan(html.indexOf('src="src/app.jsx"'));
  });

  it("routes the sidebar entry and deep links to the documentation reader", () => {
    const ui = source("ui.jsx");
    const app = source("app.jsx");
    expect(ui).toContain("go('documentation')");
    expect(ui).toContain('type="button"');
    expect(app).toContain("#docs=${encodeURIComponent(route.page || 'overview')}");
    expect(app).toContain("hashParams.get('docs')");
    expect(app).toContain("<DocsView page={route.page}");
  });

  it("keeps the static guide available without a workspace key", () => {
    const app = source("app.jsx");
    expect(app).toContain("auth.phase === 'login' && route.name !== 'documentation'");
    expect(app).toContain("route.name !== 'credentialHealth' && route.name !== 'documentation'");
  });

  it("uses local Markdown as the single content source and stays browser-parseable", () => {
    const docs = source("docs.jsx");
    const docsDirectory = join(consoleRoot, "..", "docs");
    expect(docs).toContain("fetch(current.path");
    expect(docs).toContain("navigator.clipboard.writeText(markdown)");
    expect(docs).toContain("Open Markdown");
    expect(docs).toContain("Beyond v1");
    expect(docs).toContain("#{1,3}");
    const pages = [
      "overview", "quickstart", "console", "migration",
      "agents", "tools", "permissions", "skills", "integrations",
      "environments", "sandbox-reference", "self-hosted-sandboxes", "sandbox-security",
      "sessions", "session-operations", "events", "files", "vaults",
      "github", "outcomes", "memory", "dreams", "multiagent", "scheduled-deployments", "webhooks",
      "reference",
    ];
    for (const page of pages) {
      const markdown = join(docsDirectory, `${page}.md`);
      expect(docs).toContain(`['${page}',`);
      expect(existsSync(markdown), markdown).toBe(true);
      expect(readFileSync(markdown, "utf8")).toMatch(/^# .+/);
      expect(readFileSync(markdown, "utf8")).toContain("Status:");
    }
    expect(readFileSync(join(docsDirectory, "permissions.md"), "utf8")).toContain("after five minutes");
    expect(readFileSync(join(docsDirectory, "files.md"), "utf8")).toContain("at most 10 mounted files");
    expect(readFileSync(join(docsDirectory, "webhooks.md"), "utf8")).toContain("Not ready in v1");
    expect(readFileSync(join(docsDirectory, "multiagent.md"), "utf8")).toContain("rejected");
    for (const page of pages) {
      const targets = [...readFileSync(join(docsDirectory, `${page}.md`), "utf8").matchAll(/\]\(#docs=([a-z0-9-]+)\)/g)].map((match) => match[1]);
      for (const target of targets) expect(pages).toContain(target);
    }

    const context = { self: {}, window: {} };
    context.self = context.window;
    vm.runInNewContext(readFileSync(join(consoleRoot, "..", "vendor", "babel.min.js"), "utf8"), context);
    expect(() => context.Babel.transform(docs, { presets:["react"] })).not.toThrow();
  });
});
