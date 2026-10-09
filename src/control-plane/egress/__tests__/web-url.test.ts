import { describe, expect, it } from "vitest";
import { parseNetworkingConfig, type EgressPolicy } from "../policy.ts";
import { validateWebUrl } from "../web-url.ts";

// Plan 0149: one validator for every URL a web tool dials (the initial URL, a
// near-match substitute, every redirect hop), against the environment's full
// egress policy.

const hosted = parseNetworkingConfig({
  networking: { type: "limited", allowed_hosts: ["docs.example.com", "*.example.org"] },
}) as EgressPolicy;

const native = parseNetworkingConfig({
  networking: {
    allow: [
      { host: "api.example.net", port: 443, pathPrefix: "/v1" },
      { host: "plain.example.net", port: 80 },
      { host: "tunnel.example.net", port: 443, opaqueTunnel: true },
    ],
    credentials: [],
  },
}) as EgressPolicy;

const code = (url: string, policy: EgressPolicy | undefined = hosted) => {
  const result = validateWebUrl(url, policy);
  return result.ok ? "ok" : result.code;
};

describe("web URL validation", () => {
  it("allows an https URL on an allowed host", () => {
    expect(code("https://docs.example.com/guide?page=2")).toBe("ok");
  });

  it("allows a subdomain of a wildcard entry", () => {
    expect(code("https://a.b.example.org/")).toBe("ok");
  });

  it("refuses the bare suffix of a wildcard entry", () => {
    expect(code("https://example.org/")).toBe("url_not_allowed");
  });

  it("refuses a host that is not allowed", () => {
    expect(code("https://evil.example.com/")).toBe("url_not_allowed");
  });

  it("refuses an allowed host on another port", () => {
    expect(code("https://docs.example.com:8443/")).toBe("url_not_allowed");
  });

  it("refuses plain http, even where a native entry allows port 80", () => {
    expect(code("http://plain.example.net/", native)).toBe("url_not_allowed");
  });

  it("refuses a path outside a native entry's prefix", () => {
    expect(code("https://api.example.net/v2/users", native)).toBe("url_not_allowed");
  });

  it("allows a path inside a native entry's prefix", () => {
    expect(code("https://api.example.net/v1/users", native)).toBe("ok");
  });

  it("refuses an opaque-tunnel entry, which grants no inspected requests", () => {
    expect(code("https://tunnel.example.net/", native)).toBe("url_not_allowed");
  });

  it("refuses a URL with userinfo", () => {
    expect(code("https://user:pass@docs.example.com/")).toBe("url_not_allowed");
  });

  it("refuses a URL that looks like it carries a credential", () => {
    expect(code("https://docs.example.com/x?api_key=abc123")).toBe("url_not_allowed");
  });

  it("refuses a URL that carries a known secret token format", () => {
    expect(code("https://docs.example.com/x?q=ghp_0123456789abcdefghijABCDEFGHIJ012345")).toBe("url_not_allowed");
  });

  it.each([
    ["camelCase token parameter", "https://docs.example.com/x?accessToken=abc"],
    ["generic key parameter", "https://docs.example.com/x?key=abc"],
    ["Google API key value", "https://docs.example.com/x?q=AIzaSy012345678901234567890123456789012"],
  ])("refuses a credential-looking URL: %s", (_name, url) => {
    expect(code(url)).toBe("url_not_allowed");
  });

  it("does not throw on malformed percent-encoding", () => {
    expect(code("https://docs.example.com/%?q=%FF")).toBe("ok");
  });

  it("refuses a URL longer than 250 characters", () => {
    expect(code(`https://docs.example.com/${"a".repeat(240)}`)).toBe("url_too_long");
  });

  it("refuses everything when the environment allows no hosts", () => {
    const result = validateWebUrl("https://docs.example.com/", undefined);

    expect(result.ok ? "ok" : result.code).toBe("url_not_allowed");
  });

  it("refuses an unparseable URL", () => {
    expect(code("not a url")).toBe("invalid_url");
  });

  it("canonicalizes before matching (case, trailing dot)", () => {
    expect(code("https://DOCS.example.com./guide")).toBe("ok");
  });
});
