import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const consoleRoot = fileURLToPath(new URL("..", import.meta.url));

function source(name) {
  return readFileSync(join(consoleRoot, name), "utf8");
}

describe("alpha console workflow", () => {
  it("keeps live API mutations enabled while unsupported lifecycle writes stay disabled", () => {
    const app = source("app.jsx");
    expect(app).toContain("const mutationReadOnly = apiState.mode === 'mock'");
    expect(app).toContain("const lifecycleReadOnly = apiState.mode !== 'demo'");
    expect(app).toContain("apiMode={apiState.mode}");
    expect(app).toContain("archiveReadOnly={lifecycleReadOnly}");
  });

  it("uses real API mode even when an auth-disabled appliance has no workspace key", () => {
    const forms = source("forms.jsx");
    expect(forms).toContain("const live = apiMode === 'api'");
    expect(forms).not.toContain("const live = !!api?.hasWorkspaceKey");
    expect(forms).toContain("api.createSession(body");
    expect(forms).toContain("api.sendSessionEvents(session.id");
    expect(forms).toContain("status:'sent_after_retry'");
    expect(forms).toContain("permission_policy:{ type:'always_ask' }");
    expect(forms).toContain("createError.status === 401 && onAuthExpired");
    expect(forms).toContain("messageError.status === 401 && onAuthExpired");
    expect(forms).toContain("apiMode === 'api'");
    expect(forms).toContain("? (environments[0]?.id || '')");
    expect(forms).toContain("Create an environment first…");
  });

  it("wires authenticated SSE, prompt, interrupt, and tool confirmation without synthetic live rows", () => {
    const detail = source("detail.jsx");
    expect(detail).toContain("OmaConsoleApi.followSessionEvents(s.id");
    expect(detail).toContain("OmaConsoleApi.toUiSessionEvent(event)");
    expect(detail).toContain("type:'user.message'");
    expect(detail).toContain("type:'user.interrupt'");
    expect(detail).toContain("type:'user.tool_confirmation'");
    expect(detail).toContain("result:decision");
    expect(detail).toContain("event.type === 'agent.mcp_tool_use'");
    expect(detail).toContain("if (apiMode === 'api')");
  });

  it("keeps every browser-loaded JSX source parseable by the vendored Babel runtime", () => {
    const context = {};
    context.self = context;
    context.window = context;
    vm.runInNewContext(
      readFileSync(join(consoleRoot, "..", "vendor", "babel.min.js"), "utf8"),
      context,
    );
    for (const file of ["forms.jsx", "environments.jsx", "agents-files.jsx", "detail.jsx", "app.jsx"]) {
      expect(() => context.Babel.transform(source(file), { presets:["react"] }), file).not.toThrow();
    }
  });
});
