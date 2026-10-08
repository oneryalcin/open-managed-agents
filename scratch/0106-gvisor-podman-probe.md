# 0106 gVisor and rootless Podman probe

Date: 2026-10-08

Scratch evidence note for the two "Linux hardening probes" that plan
[0106](../docs/plans/0106-sandbox-provider-landscape.md) recommends ("Docker +
gVisor" and "Rootless Docker and Podman"). Question: can the current
`docker-local` provider (`src/control-plane/sessions/pi/sandbox/docker.ts`,
`docker-egress.ts`) run unchanged on `runsc`, or on rootless Podman via the
`docker` CLI contract?

No model calls. The probe runs the real provider through its live-Docker test
suite, not hand-rolled `docker run` commands.

## Environment

- Host: macOS arm64. Disposable colima 0.8.1 profile `oma-probe` (vz, 4 CPU,
  6 GiB), Ubuntu 24.04.1, kernel 6.8.0-50-generic, cgroup v2. The profile was
  deleted afterwards.
- Docker Engine 27.4.0, containerd 1.7.24.
- gVisor `runsc` release-20260921.0, aarch64, registered with
  `runsc install`, default `systrap` platform (no KVM needed).
- Podman 4.9.3 (Ubuntu 24.04 package), rootless, netavark, systemd cgroup
  manager.
- Node v24.18.0. Repo at `369c965`, copied onto the VM's local disk. Tests ran
  natively inside the VM.
- Sandbox image: the pinned default `DEFAULT_OMA_SANDBOX_IMAGE` digest.

## Method

Suite: `src/control-plane/sessions/pi/sandbox/__tests__/docker.test.ts` and
`docker-egress.test.ts` (51 tests; the `dockerIt` cases need a live engine).
`OMA_TEST_SANDBOX_IMAGE` points at the pinned image. Also ran
`scratch/40-docker-parallel-sessions-smoke.ts` with 5 sessions.

The runtime was swapped by putting a `docker` shim first on `PATH`. No
product code changed.

- `runc`: plain Docker (baseline).
- `runsc`: shim inserts `--runtime=runsc` after `run`/`create`.
- `podmanU`: shim execs `podman`, translating tmpfs `uid=65534,gid=65534` to
  Podman's `U` flag and dropping `uid=0,gid=0`. Without that translation no
  sandbox starts (see P1).

An earlier pass drove the VM from the macOS host (Docker over the colima
socket, Podman over `colima ssh`). It produced two artifacts, recorded here so
they are not mistaken for runtime findings:

- under gVisor, files bind-mounted from the virtiofs macOS share appear as
  `0:0`, so the egress sidecar got `EACCES` on `/bundle.json`;
- `ssh` does not forward kills or aborts to the remote `podman exec`.

The native in-VM run removed both.

## Results

| Runtime | Provider suite | Probe 40 (5 sessions) | `run --rm … true` (5 runs) |
| --- | --- | --- | --- |
| runc | 50/51 | PASS (3 s) | 105–118 ms |
| runsc | 47/51 | PASS (4 s) | 127–131 ms |
| Podman 4.9.3 raw | 0 sandboxes start | — | — |
| Podman 4.9.3 + tmpfs shim | 43/51 | preflight FAIL (P6) | 220–242 ms |

### B1 (baseline, product bug, all runtimes): upload materialization fails on the default image

`materializes session file resources into the uploads tmpfs` fails on plain
runc.

`buildDockerNormalizeUploadsArgs` runs `docker exec --user 0:0` with the
container workdir `/workspace`. That directory is a tmpfs, mode 700, owned by
65534. With `--cap-drop ALL`, root has no `CAP_DAC_OVERRIDE`, and GNU `find`
(in the OMA image) cannot save or restore its starting directory:

```text
find: Failed to change directory: /workspace: Permission denied
find: Failed to restore initial working directory: /workspace: Permission denied
```

The same command passes on `alpine:3.20` (busybox `find` does not chdir), and
it passes on the OMA image with `-w /`. The skills path loosens `/workspace` to
711 around the same step; the uploads path does not. This is not caused by
gVisor or Podman, and it should be fixed separately.

### gVisor

- **G1, works unchanged:** read-only root, `--network none`, cap-drop,
  `no-new-privileges`, tmpfs `uid=`/`gid=`, `--memory`/`--pids-limit`,
  exec/abort/timeout cleanup, grep/glob bounding, label reaper, output
  collection, and parallel sessions (probe 40 PASS). Startup costs about +15 ms
  over runc for a run-to-exit container.
- **G2, egress sidecar broken: DNS.** The 3 egress confinement tests fail with
  `oma-egress-proxy: Temporary failure in name resolution`. On a
  user-defined/`--internal` network, a runsc container cannot reach Docker's
  embedded DNS at `127.0.0.11` (the lookup times out), but the sidecar's IP
  is reachable. Docker's embedded DNS relies on iptables DNAT inside the
  container network namespace, and gVisor's netstack does not traverse it.
  Fix direction: point the proxy env at the sidecar IP, or add
  `--add-host oma-egress-proxy:<ip>`, instead of relying on the network
  alias. Default-deny (`--network none`) sessions are unaffected.
- **NOTE:** gVisor applies its own syscall filter, so the host seccomp profile
  is not what confines the guest. This is expected, not a failure.

### Rootless Podman (via `docker` CLI contract)

- **P1, blocker:** `--tmpfs …,uid=65534,gid=65534` is rejected:
  `unknown mount option "uid=65534"`. Every sandbox fails to start. Podman's
  equivalent is the `U` flag (`--tmpfs /workspace:rw,exec,mode=700,U`) or
  `--mount type=tmpfs,…,chown=true`, which chowns to `--user`. Podman's own
  inspect output records `uid=65534,gid=65534` internally, so newer Podman
  may accept the options; this was not tested.
- **P2, egress sidecar cannot read its bundle.** The sidecar runs as the
  control plane's uid. Under rootless user namespaces, host uid 501 maps to
  container root, so `--user 501:…` cannot read the 0600 `/bundle.json`
  (`ls -ln` shows it as `0 0`). `--userns=keep-id` fixes it.
- **P3, `rm -f` is slow.** `podman rm -f` sends SIGTERM to `tail -f
  /dev/null`, waits the 10 s stop timeout, then SIGKILLs: 10,196 ms against
  67 ms on Docker. Poisoned-sandbox removal therefore times out
  (`Failed to remove poisoned Docker sandbox …`). Use `rm -f -t 0` or
  `--stop-timeout 0` at create time.
- **P4, isolation checks are Docker-shaped.** `HostConfig.CapDrop` is reported
  as the expanded default list instead of `["ALL"]`. The isolation is
  equivalent, but our inspect-based assertions fail.
- **P5, test fixture:** the reaper test runs `bash:5.2`. Podman rejects short
  names without `unqualified-search-registries`. The provider's default image
  is fully qualified, so this only affects the test.
- **P6, probe 40 preflight:** `podman info` has no `.ServerVersion`, so the
  script reports "Docker daemon is not available" before running.
- **P7, unresolved:** `bounds Docker grep …` fails with
  `Glob process did not publish readiness`. Not root-caused; likely
  exec-stream differences.
- **Host prerequisites:** rootless Podman cannot apply `--memory` or
  `--pids-limit` without a systemd user session (cgroupfs fallback:
  `rootless needs no limits + no cgrouppath`). It needs `dbus-user-session`
  and `loginctl enable-linger <uid>`. Startup is about 2× runc.

## Verdict

- **gVisor: green for default-deny sessions, amber for egress.** It is the
  cheap Linux hardening flag 0106 hoped for: no provider changes needed for
  `--network none` sessions, with small overhead. Egress-enabled sessions need
  one change (resolve the sidecar by IP, not by Docker DNS) before
  `--runtime=runsc` can be offered. Proceeding needs a provider knob for the
  runtime plus that egress fix.
- **Rootless Podman: not a drop-in.** It needs at least four provider changes:
  a tmpfs ownership dialect (P1), `--userns=keep-id` for the sidecar (P2), a
  zero stop timeout (P3), and engine-aware inspect checks (P4). It also has
  host prerequisites and one unexplained exec issue (P7). This agrees with
  0106's "compatibility/hardening probe, not the production isolation target".
  It is worth doing only if a Podman-only host becomes a real user
  requirement.
- **Rootless Docker** was not probed.
- **B1** (upload materialization on the default image) is a live
  `docker-local` bug independent of both runtimes.
