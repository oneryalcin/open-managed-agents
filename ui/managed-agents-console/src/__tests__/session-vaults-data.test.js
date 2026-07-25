import { describe, expect, it } from "vitest";
import {
  agentMcpServerUrls,
  credentialMcpServerUrls,
  vaultCompatibility,
} from "../session-vaults-data.js";

const NOTION = "https://mcp.notion.com/mcp";
const SLACK = "https://mcp.slack.com/mcp";

describe("session vault compatibility", () => {
  it("requires the selected agent to declare an MCP server", () => {
    expect(vaultCompatibility({ mcpServers:[] }, { status:"loaded", credentials:[] }))
      .toMatchObject({ status:"agent_without_mcp", compatible:false });
  });

  it("matches active credentials by the runtime's exact server URL contract", () => {
    const agent = { mcpServers:[{ name:"Notion", url:NOTION }] };
    const state = { status:"loaded", credentials:[
      { auth:{ mcp_server_url:SLACK }, archived_at:null },
      { auth:{ mcp_server_url:NOTION }, archived_at:null },
    ] };
    expect(vaultCompatibility(agent, state)).toMatchObject({
      status:"compatible",
      compatible:true,
      matchingUrls:[NOTION],
    });
  });

  it("does not normalize near-matching URLs or count archived credentials", () => {
    const agent = { mcpServers:[{ name:"Notion", url:NOTION }] };
    const credentials = [
      { auth:{ mcp_server_url:`${NOTION}/` }, archived_at:null },
      { auth:{ mcp_server_url:NOTION }, archived_at:"2026-07-25T00:00:00Z" },
    ];
    expect(agentMcpServerUrls(agent)).toEqual([NOTION]);
    expect(credentialMcpServerUrls(credentials)).toEqual([`${NOTION}/`]);
    expect(vaultCompatibility(agent, { status:"loaded", credentials }))
      .toMatchObject({ status:"incompatible", compatible:false });
  });

  it("blocks creation while compatibility is loading or unavailable", () => {
    const agent = { mcpServers:[{ name:"Notion", url:NOTION }] };
    expect(vaultCompatibility(agent, { status:"loading" }).status).toBe("loading");
    expect(vaultCompatibility(agent, { status:"error" }).status).toBe("error");
  });
});
