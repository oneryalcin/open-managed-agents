# OMA's alpha coding guest. This is deliberately separate from the appliance
# image: model-directed code executes here as an unprivileged user behind the
# provider's read-only-root and default-deny network boundary.
FROM ghcr.io/astral-sh/uv:0.11.29@sha256:eb2843a1e56fd9e30c7276ce1a52cba86e64c7b385f5e3279a0e08e02dd058fc AS uv
FROM docker.io/library/node:24-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573

ARG BASH_VERSION=5.2.37-2+b9
ARG CA_CERTIFICATES_VERSION=20250419
ARG PYTHON_VERSION=3.13.5-1
ARG PYTHON_IS_PYTHON3_VERSION=3.13.3-1
ARG GIT_VERSION=1:2.47.3-0+deb13u1
ARG CURL_VERSION=8.14.1-2+deb13u4
ARG JQ_VERSION=1.7.1-6+deb13u2
ARG RIPGREP_VERSION=14.1.1-1+b4
ARG TAR_VERSION=1.35+dfsg-3.1
ARG GZIP_VERSION=1.13-1
ARG UNZIP_VERSION=6.0-29
ARG XZ_VERSION=5.8.1-1+deb13u1
ARG BZIP2_VERSION=1.0.8-6
ARG ZIP_VERSION=3.0-15
ARG FILE_VERSION=1:5.46-5
ARG BUILD_ESSENTIAL_VERSION=12.12
ARG PKG_CONFIG_VERSION=1.8.1-4

LABEL org.opencontainers.image.title="Open Managed Agents sandbox" \
      org.opencontainers.image.description="Non-root OMA coding sandbox with Node, Python, uv, Git, and ripgrep" \
      org.opencontainers.image.source="https://github.com/oneryalcin/open-managed-agents" \
      org.opencontainers.image.licenses="Elastic-2.0"

COPY --from=uv /uv /uvx /usr/local/bin/

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      "bash=${BASH_VERSION}" \
      "ca-certificates=${CA_CERTIFICATES_VERSION}" \
      "python3=${PYTHON_VERSION}" \
      "python3-venv=${PYTHON_VERSION}" \
      "python-is-python3=${PYTHON_IS_PYTHON3_VERSION}" \
      "python3-dev=${PYTHON_VERSION}" \
      "git=${GIT_VERSION}" \
      "curl=${CURL_VERSION}" \
      "jq=${JQ_VERSION}" \
      "ripgrep=${RIPGREP_VERSION}" \
      "tar=${TAR_VERSION}" \
      "gzip=${GZIP_VERSION}" \
      "unzip=${UNZIP_VERSION}" \
      "xz-utils=${XZ_VERSION}" \
      "bzip2=${BZIP2_VERSION}" \
      "zip=${ZIP_VERSION}" \
      "file=${FILE_VERSION}" \
      "build-essential=${BUILD_ESSENTIAL_VERSION}" \
      "pkg-config=${PKG_CONFIG_VERSION}" \
    && rm -rf /var/lib/apt/lists/* \
    && test "$(node --version)" = "v24.18.0" \
    && test "$(npm --version)" = "11.16.0" \
    && test "$(python3 --version)" = "Python 3.13.5" \
    && test "$(python --version)" = "Python 3.13.5" \
    && uv --version | grep -Eq '^uv 0\.11\.29( |$)' \
    && test "$(rg --version | sed -n '1s/^ripgrep //p')" = "14.1.1" \
    && git --version \
    && curl --version \
    && jq --version \
    && cc --version \
    && pkg-config --version

ENV HOME=/workspace \
    XDG_CACHE_HOME=/workspace/.cache \
    TMPDIR=/workspace \
    TMP=/workspace \
    TEMP=/workspace \
    UV_CACHE_DIR=/workspace/.cache/uv \
    UV_PYTHON_DOWNLOADS=0 \
    PIP_CACHE_DIR=/workspace/.cache/pip \
    NPM_CONFIG_CACHE=/workspace/.cache/npm \
    NPM_CONFIG_PREFIX=/workspace/.local \
    COREPACK_HOME=/workspace/.cache/corepack \
    PATH=${PATH}:/workspace/.local/bin:/workspace/.venv/bin

WORKDIR /workspace
USER 65534:65534

CMD ["sleep", "infinity"]
