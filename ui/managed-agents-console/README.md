# Managed Agents Console

Static first-pass implementation of the OMA Managed Agents Console handoff.

Run it from the repository root:

```bash
npm run ui:dev
```

Then open:

```text
http://127.0.0.1:4177/
```

The dev server proxies same-origin `/v1/*` requests to the local OMA API. By
default it expects the CWC example server on `http://127.0.0.1:40178`:

```bash
OMA_PROBE_PORT=40178 npx tsx examples/ship-your-first-managed-agent/oma-server.ts
```

Override the API target when needed:

```bash
OMA_CONSOLE_API_BASE=http://127.0.0.1:4000 npm run ui:dev
```

This proxy is a local development convenience. Do not expose it as a shared or
hosted gateway; it forwards browser request headers to the configured local API.

If the API is unavailable, the console falls back to the bundled demo data and
shows a small warning banner.

When the console is backed by the API, it is intentionally read-only: create,
archive, delete, interrupt, and message-send controls are disabled until those
mutations are wired to real API calls.
