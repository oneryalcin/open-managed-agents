import { describe, expect, it } from "vitest";
import {
  credentialRow,
  healthState,
  isCurrentVaultResult,
  relativeTime,
  toneBadgeClass,
  truncationWarning,
  validationDetail,
  validationOutcome,
  vaultRow,
} from "../vaults-data.js";

describe("vault display data", () => {
  it("allowlists credential display fields and excludes token-like input", () => {
    const row = credentialRow({
      id: "vcrd_1", display_name: "MCP", archived_at: null,
      access_token: "top-level-secret",
      auth: {
        type: "mcp_oauth", mcp_server_url: "https://mcp.example.test/mcp",
        access_token: "access-secret", refresh_token: "refresh-secret",
        refresh: { token_endpoint: "https://auth.example.test/token", client_secret: "client-secret", token_endpoint_auth: { type: "none" } },
      },
    });
    expect(JSON.stringify(row)).not.toMatch(/secret/);
    expect(row.refresh.tokenEndpointHost).toBe("auth.example.test");
  });

  it("allowlists vault display fields", () => {
    const row = vaultRow({ id: "vlt_1", display_name: "Prod", created_at: "2026-01-01T00:00:00Z", archived_at: null, secret_field: "nope" });
    expect(row).toEqual({ id: "vlt_1", displayName: "Prod", createdAt: "2026-01-01T00:00:00Z", archivedAt: null });
    expect(JSON.stringify(row)).not.toMatch(/nope/);
  });

  it("classifies every health state", () => {
    expect(healthState({ hasRefresh:false }).label).toBe("n/a");
    expect(healthState({ hasRefresh:true, refreshStatus:"ok" })).toEqual({ label:"ok", tone:"ok" });
    expect(healthState({ hasRefresh:true, refreshStatus:"invalid" })).toEqual({ label:"invalid", tone:"error" });
    expect(healthState({ hasRefresh:true, refreshStatus:"transient" })).toEqual({ label:"transient", tone:"warn" });
    expect(healthState({ hasRefresh:true, refreshStatus:null })).toEqual({ label:"not attempted", tone:"neutral" });
  });

  it("classifies every validation outcome", () => {
    expect(validationOutcome({ status:"valid" }).tone).toBe("ok");
    expect(validationOutcome({ status:"invalid" }).tone).toBe("error");
    expect(validationOutcome({ status:"unknown", refresh:{ status:"skipped" } })).toMatchObject({ tone:"neutral" });
    expect(validationOutcome({ status:"unknown", refresh:{ status:"failed" } }).tone).toBe("warn");
    expect(validationOutcome({ status:"unknown" }).message).toContain("Could not conclude");
  });

  it("surfaces refresh status/http detail on a validation result", () => {
    const detail = validationDetail({ status:"invalid", mcp_probe:{ http_response:{ status_code:401 } }, refresh:{ status:"failed", http_response:{ status_code:400 } } });
    expect(detail).toEqual({ probeStatus:401, refreshStatus:"failed", refreshHttpStatus:400 });
    expect(validationDetail({})).toEqual({ probeStatus:null, refreshStatus:null, refreshHttpStatus:null });
  });

  it("maps tones onto badge classes", () => {
    expect(toneBadgeClass("ok")).toBe("st-active");
    expect(toneBadgeClass("warn")).toBe("st-rescheduling");
    expect(toneBadgeClass("error")).toBe("st-error");
    expect(toneBadgeClass("neutral")).toBe("st-idle");
    expect(toneBadgeClass("bogus")).toBe("st-idle");
  });

  it("formats relative time and tolerates missing/invalid input", () => {
    const now = Date.parse("2026-07-10T00:00:00Z");
    expect(relativeTime("2026-07-10T00:30:00Z", now)).toBe("in 30m");
    expect(relativeTime("2026-07-09T22:00:00Z", now)).toBe("2h ago");
    expect(relativeTime(null, now)).toBe("—");
    expect(relativeTime("not-a-date", now)).toBe("—");
  });

  it("names the truncation warning per list", () => {
    expect(truncationWarning("vaults")).toMatch(/^Vault list/);
    expect(truncationWarning("credentials")).toMatch(/^Credential list/);
  });

  it("drops stale detail results", () => {
    expect(isCurrentVaultResult(2, 2, "vlt_a", "vlt_a")).toBe(true);
    expect(isCurrentVaultResult(1, 2, "vlt_a", "vlt_b")).toBe(false);
  });
});
