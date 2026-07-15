import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const consoleRoot = fileURLToPath(new URL("..", import.meta.url));

function source(name) {
  return readFileSync(join(consoleRoot, name), "utf8");
}

describe("environment console slice", () => {
  it("loads the environments surface before the app mounts", () => {
    const html = readFileSync(join(consoleRoot, "..", "index.html"), "utf8");
    expect(html.indexOf('src="src/environments.jsx"')).toBeGreaterThan(0);
    expect(html.indexOf('src="src/environments.jsx"')).toBeLessThan(html.indexOf('src="src/app.jsx"'));
  });

  it("makes Environments a real sidebar route and keeps Start readiness visible", () => {
    const ui = source("ui.jsx");
    const app = source("app.jsx");
    expect(ui).toContain("{ key:'start', label:'Start'");
    expect(ui).toContain("{ key:'environments', label:'Environments'");
    expect(ui).not.toContain("Read-only</div>");
    expect(app).toContain("if (route.name === 'environments')");
    expect(app).toContain("ReadinessView");
  });

  it("posts only the safe environment schema with workspace auth headers", () => {
    const env = source("environments.jsx");
    const api = source("api.js");
    expect(env).toContain('api.createEnvironment({ name: trimmed, config: DEFAULT_ENV_CONFIG })');
    expect(api).toContain('if (creds.workspaceKey) headers["x-api-key"] = creds.workspaceKey');
    expect(api).toContain('headers["anthropic-beta"] = BETA_HEADER');
    expect(api).toContain('capability: CREATE_ENVIRONMENT_CAPABILITY');
    expect(env).toContain('networking: { type: "limited", allowed_hosts: [] }');
    expect(env).not.toMatch(/sandbox_provider:\s*["']/);
    expect(env).not.toMatch(/model.*health|sandbox.*healthy|credential.*healthy/i);
  });

  it("handles in-flight, validation error, and 401 relogin states", () => {
    const env = source("environments.jsx");
    expect(env).toContain("aria-busy={busy}");
    expect(env).toContain("EnvironmentError error={error}");
    expect(env).toContain("err.status === 401 && onAuthExpired");
    expect(env).toContain("disabled={!valid}");
  });
});
