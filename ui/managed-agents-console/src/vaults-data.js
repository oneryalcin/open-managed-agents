// Pure data helpers for the Vaults and Credential health panels. Keep raw API
// records out of JSX so the browser only receives the display fields it needs.
export function vaultRow(vault) {
  return {
    id: String(vault?.id ?? ""),
    displayName: String(vault?.display_name || vault?.id || "Unnamed vault"),
    createdAt: vault?.created_at ?? null,
    archivedAt: vault?.archived_at ?? null,
  };
}

export function credentialRow(credential) {
  const auth = credential?.auth || {};
  const refresh = auth?.refresh || null;
  return {
    id: String(credential?.id ?? ""),
    displayName: String(credential?.display_name || credential?.id || "Unnamed credential"),
    authType: auth.type === "mcp_oauth" ? "mcp_oauth" : "static_bearer",
    serverUrl: typeof auth.mcp_server_url === "string" ? auth.mcp_server_url : "",
    expiresAt: auth.expires_at ?? null,
    archivedAt: credential?.archived_at ?? null,
    refresh: refresh && typeof refresh === "object" ? {
      tokenEndpointHost: urlHost(refresh.token_endpoint),
      scope: typeof refresh.scope === "string" ? refresh.scope : null,
      endpointAuth: refresh.token_endpoint_auth?.type ?? null,
    } : null,
  };
}

export function urlHost(value) {
  try { return new URL(value).host || "—"; } catch { return "—"; }
}

export function relativeTime(value, now = Date.now()) {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) return "—";
  const seconds = Math.round((at - now) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 60) return seconds >= 0 ? "in under a minute" : "just now";
  const minutes = Math.round(absolute / 60);
  if (minutes < 60) return seconds >= 0 ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return seconds >= 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return seconds >= 0 ? `in ${days}d` : `${days}d ago`;
}

export function healthState(row) {
  if (!row?.hasRefresh) return { label: "n/a", tone: "neutral" };
  if (row.refreshStatus === "ok") return { label: "ok", tone: "ok" };
  if (row.refreshStatus === "invalid") return { label: "invalid", tone: "error" };
  if (row.refreshStatus === "transient") return { label: "transient", tone: "warn" };
  return { label: "not attempted", tone: "neutral" };
}

export function validationOutcome(result) {
  if (result?.status === "valid") return { tone: "ok", message: "Credential works." };
  if (result?.status === "invalid") return { tone: "error", message: "Re-authorize with the provider and rotate the credential." };
  if (result?.status === "unknown" && result?.refresh?.status === "skipped") {
    return { tone: "neutral", message: "Refresh was skipped; the probe was inconclusive. The credential may have changed or been checked recently." };
  }
  return { tone: "warn", message: "Could not conclude (transient or unreachable); try again later." };
}

export function isCurrentVaultResult(epoch, currentEpoch, vaultId, currentVaultId) {
  return epoch === currentEpoch && vaultId === currentVaultId;
}
