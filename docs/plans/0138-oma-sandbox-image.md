# Plan 0138 -- Minimal OMA sandbox image and pinned ripgrep

Status: implementation in progress

Date: 2026-07-16
Branch: `dev/alpha-sandbox-image`
Tracks: [issue #187](https://github.com/oneryalcin/open-managed-agents/issues/187)

## Goal

Ship a minimal OMA-owned guest image for Docker-local and microsandbox-local,
then replace the provider-owned BusyBox/POSIX `grep -E` engine with the pinned
in-guest `ripgrep` supplied by that image.

This is not the broader Python/Node development-environment arc.

## Image contract

- Alpine 3.22 pinned by multi-platform digest.
- Bash 5.2.37-r0 and ripgrep 14.1.1-r0 pinned at build time.
- Default user `65534:65534` and workdir `/workspace`.
- `linux/amd64` and `linux/arm64` publication to GHCR.
- No mutable `latest` tag.
- Maximum 25 MiB compressed per runtime platform.
- BuildKit SBOM/provenance, CRITICAL vulnerability scan, and GitHub artifact
  attestation in the publishing workflow.
- Runtime defaults use a published digest, not a mutable tag.

## Runtime contract

- Keep OMA's public input bounds, permissions, accounting, cancellation,
  timeout, raw/output ceilings, token-owned cleanup, and sandbox poisoning.
- Use one in-guest `rg --files-with-matches --null` process for traversal,
  glob filtering, regex matching, binary detection, and path output.
- Preserve hidden/ignored-file traversal with `--hidden --no-ignore`, matching
  the previously shipped `find`-based behavior.
- Custom images fail closed during semantic preflight when `rg` is missing or
  incompatible.
- No host `rg`, host `grep`, Pi grep, or JavaScript-regex fallback becomes
  model-facing.

## Delivery sequence

1. Commit and locally verify the image and multi-platform release workflow.
2. Publish the first immutable image through GitHub Actions and record its
   digest.
3. Pin that digest as the Docker/microsandbox default.
4. Land the one-process provider-owned `rg` runtime and real-provider tests.
5. Update ALPHA, PARITY, handoff, README, and issue #187 only after the pinned
   runtime path is verified.

## Acceptance

- Local image smoke passes and actual size stays below the budget.
- Multi-platform OCI inspection reports both target platforms below 25 MiB.
- Docker and microsandbox preflight and search use `rg`.
- Hosted-probe-derived path-list, `head_limit`, glob, invalid-regex,
  missing-path, and binary-ish behavior remains covered.
- Full typecheck/tests and real Docker grep smoke pass.
