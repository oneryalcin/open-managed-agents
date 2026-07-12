# Probe 62 — hosted networking wildcard depth and HTTP semantics

This probe tests the two remaining semantics needed before translating CMA's
`limited` networking shape into OMA's egress policy:

- whether `*.nip.io` matches one-label and nested subdomains (using nip.io's
  wildcard DNS so both names resolve);
- whether the allowlist applies to HTTP as well as HTTPS;
- whether the bare suffix remains denied for both schemes.

Run:

```bash
uv run --with anthropic python scratch/62-managed-agents-networking-depth-probe.py
```

The script writes the request and runtime results to
`scratch/artifacts/62-managed-agents-networking-depth-probe.json` and cleans
up its temporary CMA resources.

## Observed result (2026-07-12)

- `*.nip.io` allowed both `www.1.1.1.1.nip.io` and the nested
  `a.b.1.1.1.1.nip.io` over HTTPS (the upstream returned 503, which still
  proves the request passed the egress filter); `nip.io` itself returned 403.
- The same one-label and nested hosts returned 403 over HTTP. For this slice,
  CMA's limited allowlist is therefore translated as HTTPS/443-only.

Artifact: [`scratch/artifacts/62-managed-agents-networking-depth-probe.json`](artifacts/62-managed-agents-networking-depth-probe.json)
