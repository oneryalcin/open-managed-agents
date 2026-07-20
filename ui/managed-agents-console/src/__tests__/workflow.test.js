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
  it("defaults first-time login to the ordinary workspace-key path", () => {
    const auth = source("auth.jsx");
    expect(auth).toContain("useStateA('workspace')");
    expect(auth).not.toContain("useStateA('admin')");
  });

  it("enables only API-backed lifecycle mutations in live mode", () => {
    const app = source("app.jsx");
    expect(app).toContain("const mutationReadOnly = apiState.state !== 'loaded'");
    expect(app).toContain("|| (apiState.mode !== 'api' && apiState.mode !== 'demo')");
    expect(app).toContain("const lifecycleReadOnly = mutationReadOnly");
    expect(app).toContain("await OmaConsoleApi.archiveAgent(a.id)");
    expect(app).toContain("await OmaConsoleApi.updateAgentToolPermission(a, policy)");
    expect(app).toContain("await OmaConsoleApi.archiveSession(s.id)");
    expect(app).toContain("await OmaConsoleApi.deleteSession(s.id)");
    expect(app).toContain("apiMode={apiState.mode}");
    expect(app).toContain("archiveReadOnly={lifecycleReadOnly}");
  });

  it("uses live model discovery and never substitutes demo rows after an API failure", () => {
    const app = source("app.jsx");
    const forms = source("forms.jsx");
    expect(app).toContain("setModels(data.models)");
    expect(app).toContain("useState(demoMode ? MODELS.map");
    expect(app).toContain("default:id === MODELS[0],\n  })) : [])");
    expect(app).toContain("setApiState({ state:'error', mode:'error', error, warnings:[] })");
    expect(app).not.toContain("setApiState({ state:'loaded', mode:'mock'");
    expect(app).toContain("<CreateAgent models={models}");
    expect(forms).toContain("const providers = [...new Set(models.map((item) => item.provider))]");
    expect(forms).toContain("model: api.modelInputForSelection(selectedModel)");
    expect(forms).toContain("Credentials are not configured for");
  });

  it("uses real API mode even when an auth-disabled appliance has no workspace key", () => {
    const forms = source("forms.jsx");
    expect(forms).toContain("const live = apiMode === 'api'");
    expect(forms).not.toContain("const live = !!api?.hasWorkspaceKey");
    expect(forms).toContain("api.createSession(body");
    expect(forms).toContain("api.sendSessionEvents(session.id");
    expect(forms).toContain("status:'sent_after_retry'");
    expect(forms).toContain("permission_policy:{ type:toolPolicy }");
    expect(forms).toContain("useStateF('always_ask')");
    expect(forms).toContain("Allow automatically");
    expect(forms).toContain("Sandbox and network restrictions still apply.");
    const agents = source("agents-files.jsx");
    expect(agents).toContain("Save new version");
    expect(agents).toContain("Existing sessions keep their current policy.");
    expect(agents).toContain("Archived agents cannot create new sessions.");
    expect(agents).toContain("a.toolPermission === 'Mixed permissions'");
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
    expect(detail).toContain("Archived sessions are read-only.");
    expect(detail).not.toContain("it can be restored");
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
