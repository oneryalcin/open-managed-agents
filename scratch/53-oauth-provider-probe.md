# 53 OAuth provider token-endpoint probe

Date: 2026-07-09

Evidence for plan 0122 M3 provider realism. This probe used only generated
bogus OAuth values; no real grants or user tokens were sent. Raw redacted
output: `scratch/artifacts/53-oauth-provider-probe.json`.

Official-doc anchors checked before probing:

- Slack `oauth.v2.access`: `POST https://slack.com/api/oauth.v2.access`,
  supports `application/x-www-form-urlencoded` and documents refresh-token
  exchange with `grant_type=refresh_token`; docs recommend HTTP Basic for
  client authentication.
- Notion authorization docs: refresh uses
  `POST https://api.notion.com/v1/oauth/token`, HTTP Basic authentication,
  and a JSON body with `grant_type: "refresh_token"` and `refresh_token`.
- Linear endpoint was probed at `https://api.linear.app/oauth/token`; the
  live endpoint response is the evidence captured here.

## Live results

| Case | Status | Body | Implication |
| --- | ---: | --- | --- |
| Slack form + Basic | 200 | `{ok:false,error:"invalid_refresh_token"}` | Slack can return OAuth failure as HTTP 200; OMA must parse body errors and classify `invalid_refresh_token` as permanent. |
| Slack form + client_secret_post | 200 | `{ok:false,error:"invalid_refresh_token"}` | Body client auth reaches the same refresh-token validation path. |
| Linear form + Basic | 401 | `{error:"invalid_client",error_description:"Invalid client: client is invalid"}` | Form + Basic is accepted far enough to produce OAuth-shaped JSON. |
| Linear form + client_secret_post | 400 | `{error:"invalid_client",error_description:"Invalid client: client is invalid"}` | Body client auth also produces OAuth-shaped JSON. |
| Notion JSON + Basic | 401 | `{error:"invalid_client",request_id:"..."}` | Matches Notion docs' JSON + Basic shape; invalid client is permanent. |
| Notion form + Basic | 401 | `{error:"invalid_client",request_id:"..."}` | Form was not rejected as unsupported in this bogus-client probe, but OMA should still follow the stored credential's configured request construction. |

## Plan impact

- Add Slack-style `ok:false` / HTTP 200 token responses to the refresh fixture.
- Add `invalid_refresh_token` to the permanent OAuth error set.
- Keep RFC-correct per-mode request construction. Provider probing did not
  require `openid-client` or a broader OAuth implementation.
