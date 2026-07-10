import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Static security assertions over the shipped console source (plan 0120 §5,
// review finding M4). These are the guarantees the backend tests cannot see:
// the browser-side promises that keys never persist, never get logged, and
// the page never phones out. A later edit that "helpfully" adds a
// remember-me localStorage write or a debug console.log of a minted key
// should fail CI here, not survive to a release.

const consoleRoot = fileURLToPath(
  new URL("../../../ui/managed-agents-console", import.meta.url),
);

function sourceFiles(): Array<{ name: string; text: string }> {
  const src = join(consoleRoot, "src");
  return readdirSync(src)
    .filter((name) => /\.(js|jsx)$/.test(name))
    .map((name) => ({ name, text: readFileSync(join(src, name), "utf8") }));
}

// Line comments would trip the greps on prose (the api.js header comment
// explains *why* localStorage is banned); strip them so only code counts.
function codeOnly(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n");
}

describe("console source security posture", () => {
  it("never touches persistent browser storage", () => {
    for (const { name, text } of sourceFiles()) {
      const code = codeOnly(text);
      expect(code, name).not.toMatch(/localStorage/);
      expect(code, name).not.toMatch(/sessionStorage/);
      expect(code, name).not.toMatch(/document\.cookie/);
    }
  });

  it("never calls console logging (keys and minted plaintext flow through here)", () => {
    // Zero-tolerance is deliberate: a "log only non-secrets" rule cannot be
    // checked statically, so the console app simply does not log.
    for (const { name, text } of sourceFiles()) {
      expect(codeOnly(text), name).not.toMatch(/console\.(log|info|warn|error|debug|trace)\(/);
    }
  });

  it("never renders server-controlled strings as raw HTML or navigable URLs", () => {
    // The console renders vault/credential/probe fields that a hostile MCP
    // server controls. React text children escape by default; the danger is a
    // later edit reaching for innerHTML or building an href/src from that
    // data. Ban both so server strings can only ever be inert text.
    for (const { name, text } of sourceFiles()) {
      const code = codeOnly(text);
      expect(code, name).not.toMatch(/dangerouslySetInnerHTML/);
      expect(code, name).not.toMatch(/\.innerHTML\s*=/);
      expect(code, name).not.toMatch(/(href|src)\s*[:=]\s*[`'"]?\s*\$\{/);
    }
  });

  it("index.html references no remote scripts, styles, or fonts", () => {
    // Self-contained is a DoD requirement (0120 §1): first paint must not
    // depend on (or leak the operator's address to) any CDN.
    const html = readFileSync(join(consoleRoot, "index.html"), "utf8");
    expect(html).not.toMatch(/(src|href)\s*=\s*["']https?:\/\//i);
    expect(html).not.toMatch(/preconnect/i);
  });

  it("ships the vendored runtime the html references", () => {
    const html = readFileSync(join(consoleRoot, "index.html"), "utf8");
    const vendored = [...html.matchAll(/src="(vendor\/[^"]+)"/g)].map((m) => m[1]!);
    expect(vendored.length).toBeGreaterThanOrEqual(3); // react, react-dom, babel
    for (const rel of vendored) {
      // Throws if missing — a broken COPY/vendoring shows up as a test fail.
      expect(readFileSync(join(consoleRoot, rel), "utf8").length, rel).toBeGreaterThan(0);
    }
  });
});
