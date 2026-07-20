# Prototype in Console

> [!NOTE] Status: **Shipped alpha.** The console is a local appliance UI, not a conversational agent builder.

Use the console to exercise the same workspace-scoped API that your integration will use. It is available at the URL printed by `oma up`; sign in with a workspace key.

The key is used once to establish a revocable console session. The browser never stores or can read the session token; the server stores only its hash. A workspace-key session is invalidated as soon as its source key is revoked. When admin mode is enabled, an admin can use the workspace selector to open any workspace directly; the selected workspace remains a separate `/v1` session, not implicit admin access.

## Build an agent

Create an agent, choose a credential-ready model, set instructions, and choose its tools and confirmation policy. Agent updates create immutable versions, so an existing session continues with the version it started with.

## Test a session

Create an immutable environment, then create a session with the selected agent and environment. Send a prompt and inspect persisted events, tool input and output, generated files, errors, and confirmation requests.

## What the console does not do

The alpha console does not generate agents from a chat, provision hosted infrastructure, or simulate writes that the server cannot perform. If an API capability is unavailable, the console leaves the action absent or explains the limitation.

## Move to code

Use the console to understand the workflow, then use the bundled [OpenAPI reference](/docs/) for request and response details. The API requires a workspace key and the managed-agents beta header; the console supplies these for its own requests.
