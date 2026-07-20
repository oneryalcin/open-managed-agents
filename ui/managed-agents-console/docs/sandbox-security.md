# Sandbox security

> [!NOTE] Status: **Shipped baseline for Docker-local.** Security posture is provider-specific and is not a substitute for your own host security controls.

## OMA-enforced baseline

Docker-local drops Linux capabilities, uses `no-new-privileges`, runs a non-root UID, mounts a read-only root filesystem, and uses constrained temporary filesystems. The default environment denies network access.

## Egress and credentials

When a Docker environment uses an approved allowlist, OMA limits traffic to HTTPS and the selected hosts. Network permission is explicit and immutable. Vault secret values are not displayed to the sandbox or console user as plaintext.

## Operator responsibilities

Protect the appliance host, Docker daemon, workspace and admin keys, and persistent OMA data. Review custom host allowlists carefully. Do not treat alpha sandboxing as a multi-tenant isolation guarantee, and do not enable an untrusted workload solely because a tool-confirmation policy allows it.
