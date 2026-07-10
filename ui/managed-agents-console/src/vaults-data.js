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

// Map a semantic tone onto an existing badge class (console.css): the accent
// wash is the amber-gold the plan calls for on transient/warn rows.
const TONE_BADGE = { ok: "st-active", warn: "st-rescheduling", error: "st-error", neutral: "st-idle" };

export function toneBadgeClass(tone) {
  return TONE_BADGE[tone] || TONE_BADGE.neutral;
}

export function truncationWarning(kind) {
  const noun = kind === "credentials" ? "Credential" : "Vault";
  return `${noun} list reached the safety cap; this view may be partial.`;
}

export function validationOutcome(result) {
  if (result?.status === "valid") return { tone: "ok", message: "Credential works." };
  if (result?.status === "invalid") return { tone: "error", message: "Re-authorize with the provider and rotate the credential." };
  if (result?.status === "unknown" && result?.refresh?.status === "skipped") {
    return { tone: "neutral", message: "Refresh was skipped; the probe was inconclusive. The credential may have changed or been checked recently." };
  }
  return { tone: "warn", message: "Could not conclude (transient or unreachable); try again later." };
}

// Presentation details for a validation result: the probe status, plus the
// refresh status/HTTP code the plan requires on invalid/failed outcomes.
export function validationDetail(result) {
  const probeStatus = result?.mcp_probe?.http_response?.status_code ?? null;
  const refreshStatus = result?.refresh?.status ?? null;
  const refreshHttpStatus = result?.refresh?.http_response?.status_code ?? null;
  return { probeStatus, refreshStatus, refreshHttpStatus };
}

export function isCurrentVaultResult(epoch, currentEpoch, vaultId, currentVaultId) {
  return epoch === currentEpoch && vaultId === currentVaultId;
}
