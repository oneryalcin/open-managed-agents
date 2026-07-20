# Environments

> [!NOTE] Status: **Shipped alpha for local sandbox configuration and bounded egress.**

Environments define where a session runs and which outbound destinations, if any, it may reach. They are immutable: changing the policy means creating a new environment and session.

## Create an environment

Create environments from the console or API. The environment stores its configuration, while the configured local provider enforces it when a session starts. The console queries the server for supported networking presets rather than inventing local options.

## Networking

New environments are Offline by default. Docker-local supports reviewed npm + PyPI, GitHub + package registries, and validated custom HTTPS host allowlists. Custom lists accept exact hosts and leading wildcards; a wildcard does not match the bare domain.

> [!WARNING] OMA has no unrestricted networking. Microsandbox-local remains offline-only. A network preset is not a promise that every third-party service or protocol will work.

## Lifecycle

List and retrieve environments through the API and console. Environment archive and delete endpoints are not available yet, so environments currently accumulate. The console does not pretend otherwise.

## Prove the supported path

```
oma smoke --egress
```

This deterministic Docker proof checks approved package and GitHub access, denial of an unrelated HTTPS host, and cleanup.
