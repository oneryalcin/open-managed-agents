# Minimal OMA guest image. Keep this separate from the appliance image and
# from the later Python/Node environment-image arc.
FROM docker.io/library/alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

ARG BASH_VERSION=5.2.37-r0
ARG RIPGREP_VERSION=14.1.1-r0

LABEL org.opencontainers.image.title="Open Managed Agents sandbox" \
      org.opencontainers.image.description="Minimal non-root OMA sandbox guest with pinned Bash and ripgrep" \
      org.opencontainers.image.source="https://github.com/oneryalcin/open-managed-agents" \
      org.opencontainers.image.licenses="Elastic-2.0"

RUN apk add --no-cache \
      "bash=${BASH_VERSION}" \
      "ripgrep=${RIPGREP_VERSION}" \
    && bash --version >/dev/null \
    && test "$(rg --version | sed -n '1s/^ripgrep //p')" = "14.1.1"

WORKDIR /workspace
USER 65534:65534

CMD ["sleep", "infinity"]
