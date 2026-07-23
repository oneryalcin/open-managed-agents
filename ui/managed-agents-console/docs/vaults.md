# Authenticate with vaults

> [!NOTE] Status: **Shipped alpha for vaults and supported MCP credential flows.**

## Create a vault

Vaults organize workspace-scoped credentials. The console can show vault and credential metadata and health without rendering secret values. The API supports vault and credential lifecycle operations, including archive and delete where the server permits them.

## Connect an OAuth MCP server

OAuth connections require MCP support to be enabled on the appliance (`OMA_ENABLE_MCP=true`) and a configured secrets master key. In the console:

1. Open **Vaults**, create or select a vault, and choose **Add credential**.
2. Leave **Connect with OAuth** selected and enter the exact URL used in the agent's `mcp_servers` configuration, such as `https://mcp.notion.com/mcp`.
3. Choose **Connect** and finish authorization in the provider window.

The browser receives an authorization URL and opaque flow status only. Access tokens, refresh tokens, client secrets, and authorization codes are exchanged and encrypted by the appliance; they are never displayed or pasted into the console.

This guided path supports URL-based, standards-compliant MCP servers that publish OAuth discovery metadata and either dynamic client registration or an existing reusable registration. A provider that lacks those capabilities produces an explicit unsupported-provider error. OMA does not ship a third-party MCP marketplace.

## Use a credential in a session

Attach the needed vault at session creation and configure the compatible MCP server on the agent. OMA resolves supported authentication inside the connector path; the sandbox does not receive a browser-visible plaintext secret.

## Supported and deferred types

OMA supports static bearer credentials and guided MCP OAuth, including validation and automatic refresh where the provider issues a refresh token. Static bearer remains available for servers that intentionally use a long-lived token. Environment-variable substitution and arbitrary secret injection are not current public credential types.

## Rotation and failures

Use **Validate** to probe the MCP server, and **Reauthorize** to renew a refreshable OAuth connection without creating a duplicate credential. **Disconnect** archives the OMA credential immediately; it does not revoke the provider-side grant, which must be revoked with the provider when required.

If an OAuth refresh or connector call fails, inspect the validation result, session events, and credential health. OMA does not claim that a credential is usable merely because its metadata exists.
