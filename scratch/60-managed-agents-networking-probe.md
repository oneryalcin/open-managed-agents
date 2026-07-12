# Probe 60 — hosted environment networking

This probe compares CMA environments configured with `networking.type` set to
`unrestricted` and `limited` (`allowed_hosts: ["example.com"]`). Each session
asks an always-allowed bash tool to run `curl` against `example.com` and
`example.org`; the artifact records the actual command output and event shape.

Run:

```bash
uv run --with anthropic python scratch/60-managed-agents-networking-probe.py
```

The probe reads `ANTHROPIC_API_KEY` from the preferred CWC `.env`, cleans up
the created sessions, agent, and environments, and writes
`scratch/artifacts/60-managed-agents-networking-probe.json`.

## Observed result (2026-07-12)

- `unrestricted`: `example.com` returned HTTP 200 and `example.org` returned
  HTTP 200.
- `limited` with `allowed_hosts: ["example.com"]`: `example.com` returned HTTP
  200, while `example.org` returned HTTP 403. The limited policy therefore
  remains network-reachable but blocks the disallowed host at the egress
  boundary; OMA should model this as a denied request rather than silently
  treating the environment as unrestricted.

Artifact: [`scratch/artifacts/60-managed-agents-networking-probe.json`](artifacts/60-managed-agents-networking-probe.json)
