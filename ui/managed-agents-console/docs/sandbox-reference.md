# Sandbox reference

> [!NOTE] Status: **Shipped alpha image reference.** This describes the pinned coding image used by the supported local providers, not a hosted CMA cloud image.

## Included tooling

The default image includes Bash, Node and npm, Python and uv, Git, curl, jq, ripgrep, common archive tools, and a basic C/C++ build baseline. It supports the built-in read, write, edit, glob, grep, and Bash workflow.

## Filesystem and identity

The guest runs as a non-root user with a read-only root filesystem. Project files, virtual environments, package caches, and npm globals belong under `/workspace`. This is an alpha coding baseline, not a promise that arbitrary system packages or language runtimes are available.

## Network access

Networking is controlled by the environment, not by the image. New environments are offline. Docker-local can use approved HTTPS presets or a validated custom host allowlist; microsandbox-local stays offline-only.

## Image selection

OMA uses a reviewed, digest-pinned image. Users cannot provide arbitrary image references through the public environment API because image selection and egress are security boundaries.
