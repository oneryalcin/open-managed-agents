import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { registerConsoleRoutes } from "../console/static.ts";
import { createDeploymentControlPlane } from "../app.ts";
import { generateAdminKey } from "../admin/auth.ts";

// Contract tests for the console static handler (plan 0120 §3.1/§5/§6). The
// threat: this is the one handler that maps request paths to filesystem
// reads, so every escape form — encoded, double-encoded, prefix-sibling,
// absolute, null byte, symlink — must 404, and the serving behavior the
// no-build console depends on (.jsx as text/babel, no-store, relative-URL
// redirect) must hold exactly.

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// A console tree with hostile neighbors: a prefix-sharing sibling directory
// (the Codex-adversarial bypass shape for a bare startsWith(root) guard), a
// parent-level secret, and an in-tree symlink pointing outside the tree.
function makeConsoleFixture() {
  const base = mkdtempSync(join(tmpdir(), "oma-console-static-"));
  tempRoots.push(base);
  const root = join(base, "console");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<html>console</html>");
  writeFileSync(join(root, "src", "api.js"), "// js");
  writeFileSync(join(root, "src", "app.jsx"), "// jsx");
  writeFileSync(join(root, "console.css"), "/* css */");
  writeFileSync(join(root, "overview.md"), "# Console overview\n");
  writeFileSync(join(root, "notes.txt"), "unlisted extension");
  // Escape targets use *servable* extensions (.html/.js): with an unlisted
  // extension the content-type 404 would mask a broken containment check and
  // the guard mutants below would survive.
  mkdirSync(join(base, "console-evil"));
  writeFileSync(join(base, "console-evil", "secret.html"), "sibling secret");
  writeFileSync(join(base, "secret.html"), "parent secret");
  symlinkSync(join(base, "secret.html"), join(root, "escape.html"));

  const app = new Hono();
  app.get("/v1/probe", (c) => c.text("api"));
  registerConsoleRoutes(app, { root });
  return app;
}

function get(app: Hono, path: string): Promise<Response> {
  return Promise.resolve(
    app.fetch(new Request(`http://console.test${path}`, { redirect: "manual" })),
  );
}

describe("console static serving", () => {
  it("redirects the bare mount to the trailing-slash form", async () => {
    // The console's asset URLs are relative; served at /console they would
    // resolve to /src/… and 404. The redirect is what makes them resolve.
    const res = await get(makeConsoleFixture(), "/console");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/console/");
  });

  it("serves index.html at the mount root", async () => {
    const res = await get(makeConsoleFixture(), "/console/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("<html>console</html>");
  });

  it.each([
    ["/console/src/api.js", "text/javascript; charset=utf-8"],
    ["/console/src/app.jsx", "text/babel; charset=utf-8"],
    ["/console/console.css", "text/css; charset=utf-8"],
    ["/console/overview.md", "text/markdown; charset=utf-8"],
  ])("serves %s as %s", async (path, contentType) => {
    const res = await get(makeConsoleFixture(), path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(contentType);
  });

  it("sends no-store, a CSP with connect-src 'self', and DENY framing on assets", async () => {
    // no-store: a proxy/browser cache must not retain the console shell that
    // will hold keys. connect-src 'self': an injected script cannot POST the
    // admin key off-origin. frame-ancestors: no clickjacking an authed panel.
    const res = await get(makeConsoleFixture(), "/console/");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it.each([
    ["missing file", "/console/nope.js"],
    ["directory", "/console/src"],
    ["unlisted extension", "/console/notes.txt"],
  ])("404s a %s", async (_label, path) => {
    const res = await get(makeConsoleFixture(), path);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  // Literal ../ and %2e%2e/ are collapsed by WHATWG URL parsing before
  // routing (verified by probe), so the forms below are the ones that
  // actually reach the handler carrying escape intent.
  it.each([
    ["encoded slash traversal", "/console/..%2fsecret.html"],
    ["encoded dots and slash", "/console/%2e%2e%2fsecret.html"],
    ["double-encoded traversal", "/console/%252e%252e%252fsecret.html"],
    ["prefix-sharing sibling dir", "/console/..%2fconsole-evil%2fsecret.html"],
    ["absolute path", "/console/%2fetc%2fpasswd"],
    ["null byte", "/console/index.html%00.js"],
    ["invalid percent escape", "/console/%zz"],
  ])("blocks %s", async (_label, path) => {
    const res = await get(makeConsoleFixture(), path);
    expect(res.status).toBe(404);
  });

  it("blocks a symlink inside the tree that points outside it", async () => {
    const res = await get(makeConsoleFixture(), "/console/escape.html");
    expect(res.status).toBe(404);
  });

  it("blocks a literal ../ delivered raw through the node server (production input shape)", async () => {
    // app.fetch(new Request(...)) WHATWG-normalizes ../ away before routing,
    // but @hono/node-server hands the handler the RAW request target — the
    // most common traversal shape only exists in production. Drive it with
    // Node's http client, which sends the path verbatim.
    const app = makeConsoleFixture();
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () =>
        resolve(s),
      );
    });
    try {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const status = (path: string) =>
        new Promise<number>((resolve, reject) => {
          const req = httpRequest({ host: "127.0.0.1", port, path }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on("error", reject);
          req.end();
        });
      // Control first: the live-socket path serves real assets…
      expect(await status("/console/index.html")).toBe(200);
      // …and the raw traversal forms 404.
      expect(await status("/console/../secret.html")).toBe(404);
      expect(await status("/console/../../etc/passwd")).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("does not shadow non-console routes", async () => {
    const res = await get(makeConsoleFixture(), "/v1/probe");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("api");
  });
});

describe("console in the deployment assembly", () => {
  it("serves the bundled console with auth enabled, without any key", async () => {
    // The console is secret-free static content: reachable before login even
    // when every /v1 and /admin route demands a credential.
    const root = mkdtempSync(join(tmpdir(), "oma-console-deploy-"));
    tempRoots.push(root);
    const plane = createDeploymentControlPlane({
      OMA_HOME: root,
      OMA_SQLITE_PATH: join(root, "oma.sqlite"),
      OMA_FILE_STORAGE_ROOT: join(root, "objects"),
      OMA_AUTH_MODE: "api-key",
      OMA_ADMIN_KEY: generateAdminKey(),
    });
    try {
      const console_ = await plane.app.request("/console/");
      expect(console_.status).toBe(200);
      expect(await console_.text()).toContain("Managed Agents Console");

      // And the API routes still answer (401, not 404 — not shadowed).
      const v1 = await plane.app.request("/v1/agents");
      expect(v1.status).toBe(401);
      const admin = await plane.app.request("/admin/workspaces");
      expect(admin.status).toBe(401);
    } finally {
      plane.stores.close();
    }
  });
});
