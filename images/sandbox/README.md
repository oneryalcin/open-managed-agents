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
