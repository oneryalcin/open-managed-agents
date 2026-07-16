# OMA sandbox image

This is the minimal default guest image used by the Docker-local and
microsandbox-local providers. It is deliberately separate from the OMA
appliance image.

It contains only:

- Alpine Linux 3.22, pinned by multi-platform digest;
- Bash 5.2.37-r0;
- ripgrep 14.1.1-r0;
- Alpine's existing BusyBox utilities required by the sandbox providers.

Python, Node.js, compilers, and package-manager convenience tooling belong to
the later environment-image arc.

Build and smoke it locally with:

```bash
make sandbox-image-smoke
```

The published image is multi-platform (`linux/amd64`, `linux/arm64`) and must
remain below the compressed-size limit enforced by its release workflow.
