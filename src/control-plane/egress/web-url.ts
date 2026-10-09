import { authorizeRequestUrl, type EgressPolicy } from "./policy.ts";

// Plan 0149: the one validator for every URL a control-plane web tool dials:
// the requested URL, a near-match substitute, and every redirect hop. The
// SSRF guard (guarded-fetch.ts) still vets the resolved address at dial time.

/** Hosted's limit on fetchable URL length. */
export const MAX_WEB_URL_LENGTH = 250;

export type WebUrlCheck =
  | { ok: true; url: URL }
  | { ok: false; code: "url_not_allowed" | "url_too_long" | "invalid_url"; reason: string };

export function validateWebUrl(raw: string, policy: EgressPolicy | undefined): WebUrlCheck {
  if (raw.length > MAX_WEB_URL_LENGTH) {
    return { ok: false, code: "url_too_long", reason: `URL longer than ${MAX_WEB_URL_LENGTH} characters` };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "invalid_url", reason: "not a valid URL" };
  }
  // A trailing dot names the same host; drop it so it matches the allowlist.
  if (url.hostname.endsWith(".")) url.hostname = url.hostname.slice(0, -1);
  const refuse = (reason: string): WebUrlCheck => ({ ok: false, code: "url_not_allowed", reason });
  if (policy === undefined) return refuse("this environment allows no web hosts");
  // https only: a redirect must not downgrade even where a native entry
  // allows plain http.
  if (url.protocol !== "https:") return refuse("only https URLs can be fetched");
  if (url.username !== "" || url.password !== "") return refuse("the URL contains credentials");
  if (looksLikeCredential(url)) return refuse("the URL appears to contain a credential");
  const authorized = authorizeRequestUrl(policy, url);
  if (!authorized.allowed) return refuse(authorized.reason);
  // An opaque-tunnel grant is for uninspected client tunnels (mTLS), not for
  // requests the control plane makes and inspects.
  if (authorized.entry.opaqueTunnel) return refuse(`${url.hostname} is granted only as an opaque tunnel`);
  return { ok: true, url };
}

const CREDENTIAL_PARAM = /(?:^|[_-])(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|pwd|auth|signature|sig|credential)s?$/i;
// Common provider token shapes (GitHub, Slack, OpenAI/Anthropic-style keys, AWS).
const CREDENTIAL_VALUE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/;

function looksLikeCredential(url: URL): boolean {
  for (const [name, value] of url.searchParams) {
    if (CREDENTIAL_PARAM.test(name) && value !== "") return true;
  }
  return CREDENTIAL_VALUE.test(decodeURIComponent(url.pathname + url.search));
}
