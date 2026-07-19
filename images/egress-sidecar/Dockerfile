# Dedicated OMA egress security boundary. Build from the repository root so
# the image contains the exact reviewed proxy source while carrying only its
# single external runtime dependency.
FROM docker.io/library/node:24-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573

LABEL org.opencontainers.image.title="Open Managed Agents egress sidecar" \
      org.opencontainers.image.description="Per-session default-deny HTTPS egress proxy for OMA" \
      org.opencontainers.image.source="https://github.com/oneryalcin/open-managed-agents" \
      org.opencontainers.image.licenses="Elastic-2.0"

WORKDIR /app
COPY images/egress-sidecar/package.json images/egress-sidecar/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force
COPY src ./src

ENV HOME=/tmp
USER 65534:65534
CMD ["node", "--experimental-transform-types", "--disable-warning=ExperimentalWarning", "src/egress-proxy-main.ts"]
