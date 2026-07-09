# 52 MCP OAuth hosted probe

Date: 2026-07-09

Evidence for plan 0122 M3 (`mcp_oauth` + refresh). Live calls used the
hosted Anthropic Managed Agents API with `ANTHROPIC_API_KEY` loaded only from
`/Users/oner/dev/junk/cwc-workshops/.env`; the ambient shell key was not used.
Raw redacted output: `scratch/artifacts/52-mcp-oauth-hosted-probe.json`.

## Result summary

- `mcp_oauth` create/read/list response `auth` subset:
  - no refresh block: `type`, `mcp_server_url`, optional `expires_at`;
  - refresh block: `type`, `mcp_server_url`, optional `expires_at`,
    `refresh.token_endpoint`, `refresh.client_id`, `refresh.scope`, and
    `refresh.token_endpoint_auth.type`;
  - write-only fields (`access_token`, `refresh_token`, `client_secret`) were
    absent in create/get/list/update responses.
- `expires_at` is optional both with and without a refresh block. If supplied,
  it must be in the future; a past value returned 400
  `"auth.expires_at must be in the future."`
- Updating only `access_token`/`expires_at` plus
  `refresh.refresh_token` succeeds and preserves structural refresh fields.
- Updating structural fields returns 400:
  - `refresh.token_endpoint` -> unknown field `"token_endpoint"`;
  - `refresh.client_id` -> unknown field `"client_id"`.
- `mcp_oauth_validate`:
  - no refresh token -> 200 `vault_credential_validation`, status `invalid`,
    `has_refresh_token: false`, `refresh.status: "no_refresh_token"`;
  - bogus refresh token -> 200 `vault_credential_validation`, status
    `unknown`, `has_refresh_token: true`, `refresh.status: "failed"`;
  - `static_bearer` credential -> 400 invalid request;
  - archived `mcp_oauth` credential -> 400 invalid request,
    `"Credential is archived."`
- In the final reflective token-endpoint run, hosted returned
  `refresh.http_response: null` for the generated-secret `postman-echo`
  endpoint. The probe did not observe a token-bearing refresh response body.
  OMA's stricter no-body floor for validate remains appropriate.
- Cleanup archived and deleted the probe vault successfully.

## Plan impact

- Replace the interim `expires_at required with refresh` rule with:
  `expires_at` is optional; if present, it must be future.
- Replace archived-validate interim 404 with hosted-shaped 400.
- Keep the readable response subset exactly as above.
- Keep static-bearer validate as 400.
