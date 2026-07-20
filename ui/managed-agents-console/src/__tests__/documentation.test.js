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
    for (const page of ["overview", "quickstart", "agents", "environments", "tools", "integrations", "sessions", "reference"]) {
      const markdown = join(docsDirectory, `${page}.md`);
      expect(existsSync(markdown), markdown).toBe(true);
      expect(readFileSync(markdown, "utf8")).toMatch(/^# .+/);
    }
    expect(readFileSync(join(docsDirectory, "overview.md"), "utf8")).toContain("does not currently offer web search/fetch");
    expect(readFileSync(join(docsDirectory, "agents.md"), "utf8")).toContain("within five minutes, OMA automatically denies");
    expect(readFileSync(join(docsDirectory, "tools.md"), "utf8")).toContain("at most 10 mounted files");

    const context = { self: {}, window: {} };
    context.self = context.window;
    vm.runInNewContext(readFileSync(join(consoleRoot, "..", "vendor", "babel.min.js"), "utf8"), context);
    expect(() => context.Babel.transform(docs, { presets:["react"] })).not.toThrow();
  });
});
