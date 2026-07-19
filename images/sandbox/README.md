# OMA sandbox image

This is the alpha coding guest used by the Docker-local and microsandbox-local
providers. It is deliberately separate from the OMA appliance image.

It contains:

- an official Node 24 Debian/glibc base pinned by multi-platform digest;
- Node.js and npm;
- Python 3 and uv;
- Git, curl, jq, Bash, and ripgrep;
- common archive tools;
- a basic C/C++ build toolchain for common npm native modules and Python
  source distributions.

It does not promise every native dependency: projects needing extra database,
crypto, image, or other system headers still require a future reviewed image
profile.

The image remains non-root and is run by OMA with a read-only root filesystem.
Project dependencies, virtual environments, npm globals, and caches belong
under `/workspace`; global package-manager mutation is unsupported.

Installing tools does not grant network access. Environments remain
default-deny, and registry access must be granted separately through OMA's
reviewed egress policy.

Build and smoke it locally with:

```bash
make sandbox-image-smoke
```

The published image is multi-platform (`linux/amd64`, `linux/arm64`) and must
remain below the measured compressed-size limit enforced by its release
workflow.

Current alpha reference:

```text
ghcr.io/oneryalcin/open-managed-agents-sandbox@sha256:6740cd54dfb3f4561b913e7790a58918969a4547b167ba4dbd15397b2907efe9
```

Registry measurements are 255.78 MiB compressed for amd64 and 247.63 MiB for
arm64. Workflow run 29683531169 proved anonymous pull, hardened offline coding
smoke, the 295 MiB/platform budget, attached BuildKit provenance/SBOM, and zero
CRITICAL findings.
