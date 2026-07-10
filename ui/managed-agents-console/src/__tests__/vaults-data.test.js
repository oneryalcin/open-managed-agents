import { describe, expect, it } from "vitest";
import {
  credentialRow,
  healthState,
  isCurrentVaultResult,
  validationOutcome,
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

  it("classifies null refresh status as not attempted and skipped validation honestly", () => {
    expect(healthState({ hasRefresh:true, refreshStatus:null })).toEqual({ label:"not attempted", tone:"neutral" });
    expect(validationOutcome({ status:"unknown", refresh:{ status:"skipped" } }).message)
      .toContain("inconclusive");
  });

  it("drops stale detail results", () => {
    expect(isCurrentVaultResult(2, 2, "vlt_a", "vlt_a")).toBe(true);
    expect(isCurrentVaultResult(1, 2, "vlt_a", "vlt_b")).toBe(false);
  });
});
