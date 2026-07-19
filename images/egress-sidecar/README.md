# OMA egress sidecar

This image is the per-session network security boundary used by Docker-local
OMA sessions. It contains the reviewed OMA proxy source plus `node-forge`; it
does not contain the coding sandbox toolchain.

Build from the repository root:

```bash
docker build -f images/egress-sidecar/Dockerfile -t oma-egress-sidecar:dev .
node scripts/smoke-egress-sidecar-image.mjs oma-egress-sidecar:dev
```

Production references use the dedicated sidecar manifest published under the
public `ghcr.io/oneryalcin/open-managed-agents-sandbox` package and must be
pinned by immutable digest. The shared package is a GHCR visibility choice;
the coding guest and sidecar remain separate images with separate manifests.
