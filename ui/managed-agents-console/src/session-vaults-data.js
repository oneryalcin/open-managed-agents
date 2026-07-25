export function agentMcpServerUrls(agent) {
  return uniqueStrings(
    (Array.isArray(agent?.mcpServers) ? agent.mcpServers : [])
      .map((server) => server?.url),
  );
}

export function credentialMcpServerUrls(credentials) {
  return uniqueStrings(
    (Array.isArray(credentials) ? credentials : [])
      .filter((credential) => !credential?.archived_at)
      .map((credential) => credential?.auth?.mcp_server_url),
  );
}

export function vaultCompatibility(agent, credentialState) {
  const agentUrls = agentMcpServerUrls(agent);
  if (agentUrls.length === 0) {
    return { status:"agent_without_mcp", compatible:false, agentUrls, credentialUrls:[] };
  }
  if (!credentialState || credentialState.status === "loading") {
    return { status:"loading", compatible:false, agentUrls, credentialUrls:[] };
  }
  if (credentialState.status === "error") {
    return { status:"error", compatible:false, agentUrls, credentialUrls:[] };
  }
  const credentialUrls = credentialMcpServerUrls(credentialState.credentials);
  const matchingUrls = credentialUrls.filter((url) => agentUrls.includes(url));
  return {
    status: matchingUrls.length > 0 ? "compatible" : "incompatible",
    compatible: matchingUrls.length > 0,
    agentUrls,
    credentialUrls,
    matchingUrls,
  };
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}
