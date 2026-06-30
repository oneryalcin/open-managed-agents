# 0110 microsandbox CLI confidence probe

Date: 2026-06-30

This scratch probe is the pre-code CLI confidence gate required by
[plan 0110 §1](../docs/plans/0110-microsandbox-local-provider.md). Earlier
microsandbox probes (0106–0109) drove the TypeScript SDK, but plan 0110 chose a
CLI-first (`msb`) provider boundary because `SandboxProvider.dispose()` is
synchronous and must tear down through `spawnSync`, mirroring Docker-local.

This probe answers: can the `msb` CLI cover every operation the first provider
slice depends on, including the two questions the plan flagged as unresolved
(volume removal after sandbox removal, and whether reap metadata exists)?

## Environment

- Host: macOS arm64.
- Node: v24.18.0 via `fnm`.
- `msb`: 0.6.1 (invoked through `fnm`).
- Image: `docker.io/library/alpine:latest` (arm64), pulled during the probe.

Environment caveat (independently reconfirmed on 2026-06-30):

- the Homebrew global wrapper `/opt/homebrew/bin/msb` fails directly with
  `env: node: No such file or directory` because the Homebrew Node it expected is
  gone;
- the same `msb` works when Node is on `PATH` via `fnm` and reports `msb 0.6.1`.

Implication for implementation: `msb` is a Node-launched CLI. When OMA spawns it
(`spawnSync`), the child environment must resolve a `node` binary. The provider
must target the `fnm`/Node-accessible `msb 0.6.1` behavior, not the broken
Homebrew-global wrapper path, and deployment docs must state the Node-on-PATH
requirement.

## Results

Passed:

- pulled `alpine:latest` successfully;
- created a named volume;
- created a no-network sandbox with the named volume mounted at `/workspace`;
- `inspect` confirmed the `/workspace` named-volume mount, `default_egress:
  deny`, labels present, and a sandbox `created_at`;
- volume `inspect` exposes `Created`, so age-based volume reaping is viable;
- `exec` works;
- `--stream` works for streamed output;
- network deny works: in-guest `wget` failed DNS with a bad-address error;
- host -> sandbox copy works;
- sandbox -> host copy works;
- stop/start preserves `/workspace` volume data;
- removing the sandbox first, then the volume, works (the teardown order the
  provider will use);
- final cleanup is clean: `sandboxes []`, `volumes []`.

Caveat found:

- timeout kills the command, but the CLI only returns `error: exec timed out
  after <N>s`; it did not surface partial stdout for the timed-out command.
  Streamed output via `--stream` still arrives live during execution, but the
  final result envelope of a timed-out command carries no buffered partial
  stdout. The provider's exit/cancellation normalization must account for this:
  a timeout/abort produces an error result, not a partial-output result.

Repo left clean; image cache now contains Alpine arm64.

## Verdict

CLI confidence probe passed. `msb` 0.6.1 covers create + named volume +
`/workspace` mount, no-network policy, exec, streamed exec, host/guest copy both
directions, stop/start volume persistence, and ordered sandbox-then-volume
removal. Reap metadata (`Created` on both sandbox and volume) is present, so the
plan's age-based reaping path is viable rather than conditional.

Two facts to fold into plan 0110 before/while coding:

1. target `msb` 0.6.1 invoked with Node on `PATH` (fnm), not the Homebrew-global
   wrapper; document the Node-on-PATH requirement;
2. timeout/abort returns an error with no partial stdout; normalize accordingly.

Not yet exercised here (deferred to provider unit/live tests, not blockers for
starting implementation): Pi file-operation parity through `msb` file
primitives vs guest shell, output-collection quota enforcement, and concurrent
multi-session resource isolation.
