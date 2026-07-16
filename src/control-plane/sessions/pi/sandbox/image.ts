/**
 * OMA-owned minimal guest image (plan 0138 / issue #187).
 *
 * Keep this as an immutable multi-platform digest. The publishing workflow
 * also emits human-readable tags, but runtime defaults must never follow them.
 */
export const DEFAULT_OMA_SANDBOX_IMAGE =
  "ghcr.io/oneryalcin/open-managed-agents-sandbox@sha256:cf5f8ce4a747987267364a7f1c6217a47fd9bbd80eefd0ba7fa0024d084a7c4a";
