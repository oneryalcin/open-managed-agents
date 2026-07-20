# Environments

Environments define where a session runs and which outbound destinations, if any, it may reach.

## Immutable network policy

New environments are offline by default. The supported choices are Offline, npm + PyPI, GitHub + package registries, or a validated custom HTTPS host allowlist. Changing the policy means creating a new environment and session.

## Execution is proven by a run

The first session tool call verifies sandbox execution. The console intentionally does not infer generic sandbox health from local browser state.

> [!WARNING] OMA does not offer unrestricted networking. Microsandbox-local remains offline-only in this alpha.

## Optional egress proof

```
oma smoke --egress
```

This deterministic proof checks approved package and GitHub access, denial of an unrelated HTTPS host, and cleanup.
