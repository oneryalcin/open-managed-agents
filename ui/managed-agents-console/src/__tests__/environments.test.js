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
    expect(env).toContain('api.createEnvironment({ name: trimmed, config: selectedConfig })');
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

  it("uses API-provided networking presets and validates custom hosts before create", () => {
    const env = source("environments.jsx");
    const app = source("app.jsx");
    const api = source("api.js");
    expect(api).toContain("listEnvironmentNetworkingPresets");
    expect(api).toContain("validateEnvironmentNetworkingHosts");
    expect(api).toContain("/v1/environments/networking-presets");
    expect(api).toContain("/v1/environments/networking-presets/validate");
    expect(app).toContain("const [networkingCatalog, setNetworkingCatalog] = useState(");
    expect(app).toContain("setNetworkingCatalog(data.networkingCatalog)");
    expect(app).toContain("networkingCatalog={networkingCatalog}");
    expect(env).toContain("networkingCatalog");
    expect(env).toContain("presetCopy");
    expect(api).toContain('"Offline"');
    expect(api).toContain('"npm + PyPI"');
    expect(api).toContain('"GitHub + package registries"');
    expect(env).toContain('Custom allowlist');
    expect(env).toContain("api.validateEnvironmentNetworkingHosts(customHosts)");
    expect(env).toContain('Create remains disabled until validation succeeds.');
  });

  it("renders exact host preview and explains immutable policy constraints", () => {
    const env = source("environments.jsx");
    expect(env).toContain("Exact generated hosts");
    expect(env).toContain("previewHosts(selectedHosts)");
    expect(env).toContain("*.example.com matches subdomains only");
    expect(env).toContain("add example.com separately for the bare domain");
    expect(env).toContain("The server separately reports whether this deployment can enforce egress");
    expect(env).toContain("supports approved HTTPS egress");
    expect(env).toContain("Environment policies are immutable");
    expect(env).toContain("create a new environment and start a new session");
    expect(env).toContain("No secrets are stored in the environment or shown to the guest");
  });

  it("labels existing environment rows as offline or allowed-host counts", () => {
    const api = source("api.js");
    const env = source("environments.jsx");
    expect(api).toContain('allowedHosts ? `${allowedHosts} allowed host${allowedHosts === 1 ? "" : "s"}` : "offline"');
    expect(api).toContain("networkingSummary");
    expect(env).toContain("environment.networkingSummary || environment.image");
  });

  it("uses live model readiness and never invents browser-visible sandbox health", () => {
    const env = source("environments.jsx");
    const app = source("app.jsx");
    expect(app).toContain("<ReadinessView agents={agents} environments={environments} models={models}");
    expect(app).toContain("onCreateAgent={createAgent}");
    expect(app).toContain("onCreateSession={() => createSession(null)}");
    expect(env).toContain("models.some((model) => model.credentials_configured)");
    expect(env).toContain("none report configured credentials");
    expect(env).toContain("Sandbox execution is verified by the first session tool run, not guessed by the browser");
    expect(env).toContain("Sandbox execution remains unverified until a session runs a tool");
    expect(env).not.toMatch(/sandbox.*healthy/i);
  });

  it("defines every literal icon used by the console", () => {
    const iconSource = source("icons.jsx");
    const defined = new Set([...iconSource.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]));
    const files = ["app.jsx", "auth.jsx", "detail.jsx", "environments.jsx", "forms.jsx", "ui.jsx"];
    const used = files.flatMap((file) =>
      [...source(file).matchAll(/<Icon\s+name="([^"]+)"/g)].map((match) => match[1]),
    );
    expect([...new Set(used)].filter((name) => !defined.has(name))).toEqual([]);
  });
});
