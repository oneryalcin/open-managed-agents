# Probe 61 — hosted networking edge semantics

This follows probe 60 with the cases needed to decide whether OMA can safely
translate CMA networking into its explicit egress policy:

- empty allowlist;
- wildcard host (`*.example.com`);
- `allow_package_managers`;
- `allow_mcp_servers`;
- URL, port-bearing, and uppercase entries in `allowed_hosts`.

Run:

```bash
uv run --with anthropic python scratch/61-managed-agents-networking-edge-probe.py
```

The script writes the request/error shapes and runtime curl results to
`scratch/artifacts/61-managed-agents-networking-edge-probe.json`, then cleans
up created resources.

## Observed result (2026-07-12)

- Empty `allowed_hosts` is accepted, and arbitrary HTTPS is denied with HTTP
  403.
- `*.example.com` allows `www.example.com` but not the base `example.com`;
  the base domain returned HTTP 403.
- `allow_package_managers: true` permits `pypi.org` (HTTP 200) even with an
  empty allowlist.
- `allow_mcp_servers: true` alone did not permit an arbitrary
  `mcp.linear.app` curl (HTTP 403), so this flag is scoped to configured MCP
  endpoints rather than being a general host bypass.
- URL and port-bearing allowlist entries are rejected with HTTP 400 and
  `invalid_request_error`. Uppercase hostnames are accepted and preserved
  verbatim, so translation must not assume CMA lowercases them.

Artifact: [`scratch/artifacts/61-managed-agents-networking-edge-probe.json`](artifacts/61-managed-agents-networking-edge-probe.json)
