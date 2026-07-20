# Authenticate with vaults

> [!NOTE] Status: **Shipped alpha for vaults and supported MCP credential flows.**

## Create a vault

Vaults organize workspace-scoped credentials. The console can show vault and credential metadata and health without rendering secret values. The API supports vault and credential lifecycle operations, including archive and delete where the server permits them.

## Use a credential in a session

Attach the needed vault at session creation and configure the compatible MCP server on the agent. OMA resolves supported authentication inside the connector path; the sandbox does not receive a browser-visible plaintext secret.

## Supported and deferred types

OMA supports the shipped static bearer and MCP OAuth flows, including validation where configured. Environment-variable substitution and arbitrary secret injection are not current public credential types.

## Rotation and failures

Archive, update, or replace credentials through their real lifecycle actions. If an OAuth refresh or connector call fails, inspect the resulting session events and credential health; OMA does not claim that a credential is usable merely because its metadata exists.
