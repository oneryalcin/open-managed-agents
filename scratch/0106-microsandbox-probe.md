# 0106 microsandbox probe

Date: 2026-06-11

This is a scratch evidence note for issue #121. It probes microsandbox as the
lean self-hosted, no-Kubernetes microVM candidate after Docker Sandboxes.

## Environment

- Host: macOS arm64, Darwin 25.4.0
- Node: v25.8.2
- npm: 11.11.1
- microsandbox npm package: 0.5.6
- microsandbox CLI: 0.5.6
- GitHub repo: `superradcompany/microsandbox`
- GitHub metadata checked with `gh repo view`: Apache-2.0, 6,516 stars,
  pushed at 2026-06-11T02:41:24Z

The user's npm config has a package time gate and `ignore-scripts=true`:

```text
before = "2026-05-12T09:04:18.813Z"
ignore-scripts = true
```

Because microsandbox 0.5.6 is newer than that gate and needs platform optional
dependencies, the probe used a temporary npm user config instead of changing
`~/.npmrc`.

## Package and command surface

The npm README describes microsandbox as:

```text
Lightweight VM sandboxes for Node.js — run AI agents and untrusted code with hardware-level isolation.
```

It says the SDK runs real microVMs, supports OCI images, guest filesystem
operations, named volumes, network policies, secrets, port publishing,
detached mode, metrics, and image cache operations.

The CLI exposed the right provider-grade operations:

```text
Sandboxes:
  run        Create a sandbox from an image and run a command in it
  create     Create a sandbox and boot it in the background
  start      Start a stopped sandbox
  stop       Stop one or more running sandboxes
  list       List all sandboxes [aliases: ls]
  status     Show sandbox status [aliases: ps]
  metrics    Show live metrics for a running sandbox
  remove     Remove one or more sandboxes [aliases: rm]
  exec       Run a command in a running sandbox
  copy       Copy files between the host and a sandbox [aliases: cp]
  logs       Show captured output from a sandbox
  ssh        Connect to a sandbox over SSH
  inspect    Show detailed sandbox configuration and status

Storage:
  volume     Manage named volumes [aliases: vol]
  snapshot   Manage disk snapshots [aliases: snap]
```

No account login or cloud credential was required for the SDK probe.

## TypeScript SDK probe

The probe installed `microsandbox@0.5.6` into a temporary npm project with an
empty temporary npm user config:

```bash
NPM_CONFIG_USERCONFIG=/tmp/.../npmrc-empty npm install microsandbox@0.5.6 --ignore-scripts=false
```

The first SDK script created a detached Alpine sandbox, executed commands,
copied a host file into the guest, copied a guest file back to the host, stopped
the sandbox, and started it again.

Key output:

```text
SANDBOX oma-probe-1781168739862
EXEC1_CODE 0
EXEC1_STDOUT "pwd=/\nNAME=\"Alpine Linux\"\n"
COPY_IN_CODE 0
COPY_IN_STDOUT "host-input-oma-probe-1781168739862\npersisted\n"
COPY_OUT "guest-output\n"
STOPPED
STARTED
```

One API usage detail: `Sandbox.get(name)` returns a handle. `handle.start()`
returns the live `Sandbox`; a stale handle should not be reused as if it were a
client. Calling `handle.connect()` immediately after discarding `handle.start()`
failed with:

```text
CustomError: sandbox 'oma-probe-1781168769254' is not running (status: Stopped)
```

Using the live object returned by `handle.start()` worked.

## Stop/start persistence

The original probe wrote its "rootfs" check to `/tmp`:

```text
RESUME_STDOUT "rootfs=cat: can't open '/tmp/rootfs-state.txt': No such file or directory\n\nvolume=volume-state\n"
```

That result was real but misclassified: `/tmp` is mounted as tmpfs by
microsandbox, so it measured tmpfs persistence rather than rootfs overlay
persistence. A follow-up verification wrote to both `/root` and `/tmp`:

```text
WRITE "overlay-state\ntmpfs-state\n"
RESUME "rootfs-overlay=overlay-state\ntmpfs=cat: can't open '/tmp/persist.txt': No such file or directory\n"
```

So rootfs overlay state under `/root` survived stop/start, while the `/tmp`
tmpfs mount did not.

A named volume mounted at `/data` also survived stop/start:

```text
SANDBOX oma-vol-probe-1781168828956
VOLUME oma-vol-probe-1781168828956-data
WRITE_CODE 0
WRITE_STDOUT "volume-state\n"
STOPPED
STARTED
RESUME_CODE 0
RESUME_STDOUT "rootfs=cat: can't open '/tmp/rootfs-state.txt': No such file or directory\n\nvolume=volume-state\n"
STOPPED_AGAIN
REMOVED
```

This is the main OMA-relevant result after correction. Microsandbox can park and
resume a sandbox, and rootfs overlay state may survive. OMA must still put
durable session workspace state in an explicit named volume or disk mount
because persistence is path-dependent and provider-owned. Do not rely on
arbitrary rootfs paths carrying session durability.

## Cleanup

Both probe sandboxes and the named volume were removed. A final SDK list returned
an empty array after the failed intermediate run was cleaned up.

## Verdict

Microsandbox is the strongest self-hosted no-Kubernetes candidate so far:

- no Docker account dependency observed;
- Apache-2.0;
- local Apple Silicon probe works;
- no daemon or hosted service setup was required;
- TypeScript SDK directly covers create, exec, filesystem copy, stop/start,
  detached mode, remove, and named volumes;
- rootfs overlay and named volume persistence give OMA plausible
  `requires_action` parking mechanisms, but only explicit volumes/disks should
  become the portable contract.

The caveats are also concrete:

- beta runtime;
- implicit rootfs persistence is not a portable OMA parking contract;
- provider contract must include explicit session workspace volume/disk
  ownership;
- output streaming, cancellation, network policy, secrets, snapshots, and crash
  cleanup still need focused probes.

Do not implement a production provider yet. The next useful microsandbox slice is
another scratch probe for streaming/cancellation, network deny defaults, secret
proxy behavior, and killed-sandbox cleanup.
