# 0107 microsandbox behavior probe

Date: 2026-06-11

This is a scratch evidence note for issue #121 and the provider-contract audit.
It checks microsandbox behavior beyond the first lifecycle/file-copy probe.

## Environment

- Host: macOS arm64, Darwin 25.4.0
- Node: v25.8.2
- microsandbox npm package: 0.5.6
- Probe temp project: `/tmp/oma-msb-sdk.IAr6G3`

The probe reused the temporary npm project from `scratch/0106-microsandbox-probe.md`.
No repo production code was changed.

## Streaming and Cancellation

Probe:

```js
const handle = await sb.shellStream(
  'i=0; while true; do echo tick-$i; i=$((i+1)); sleep 1; done',
);
// After two stdout events:
await handle.kill();
```

Observed:

```text
STREAM_KILL {"seen":["tick-0","tick-1"],"killed":true,"exitCode":-1}
```

Interpretation:

- streaming stdout works;
- `ExecHandle.kill()` terminates the running command;
- the terminal event used exit code `-1` for the killed command.

OMA implication: microsandbox has the primitives for streamed bash output and
interrupt/cancel wiring. An implementation must normalize provider-specific
killed exit codes into OMA's runtime event model.

## Network Behavior

Default network policy:

```text
NET_DEFAULT_PUBLIC {"code":0,"stdout":"public-ok\n","stderr":""}
NET_DEFAULT_PRIVATE {"code":0,"stdout":"private-fail\n","stderr":"wget: can't connect to remote host (10.0.0.1): Connection refused\n"}
```

`NetworkPolicy.none()`:

```text
NET_NONE_PUBLIC {"code":0,"stdout":"none-public-fail\n","stderr":"wget: bad address 'example.com'\n"}
```

`NetworkPolicy.allowAll()`:

```text
NET_ALLOW_ALL_PUBLIC {"code":0,"stdout":"all-public-ok\n","stderr":""}
```

Interpretation:

- default policy allows public egress;
- the default policy is implemented as deny-by-default egress plus explicit DNS
  and public-destination allow rules, with ingress defaulting to allow but no
  ports published by default;
- `NetworkPolicy.none()` blocked DNS/public egress;
- `NetworkPolicy.allowAll()` allowed public egress;
- the private-network check was inconclusive because `10.0.0.1` refused
  immediately rather than producing a policy-specific denial.

OMA implication: do not inherit microsandbox's default public egress. OMA should
choose an explicit network policy per session/provider. The current Docker-local
default is closer to deny-all.

## Secret Substitution

Attempt:

```js
Sandbox.builder(name)
  .image('alpine')
  .network((n) => n.policy(NetworkPolicy.publicOnly()))
  .secretEnv('OMA_PROBE_SECRET', secret, 'httpbin.org')
  .create();
```

Observed:

```text
SECRET_ENV_VISIBLE {"code":0,"stdout":"","stderr":""}
SECRET_HTTPBIN {"code":0,"stdout":"","stderr":"wget: download timed out\n","hostSecretAppeared":false,"placeholderAppeared":false}
```

Interpretation:

- this probe did not verify secret behavior;
- the guest env var was empty with the shorthand used above;
- the external HTTPS echo attempt timed out.

OMA implication: secret proxy behavior remains an open probe. The next attempt
should use a controlled HTTPS echo target or a provider-recommended example and
should test all three conditions:

1. real secret does not appear in guest env/process state;
2. placeholder appears where expected;
3. outbound HTTPS to an allowed host receives the substituted real value.

Do not treat microsandbox secret substitution as production-ready for OMA until
that passes.

## Detached Reconnect

Probe:

```js
const sb = await Sandbox.builder(name)
  .image('alpine')
  .detached(true)
  .create();
await sb.shell('echo reconnect-state > /tmp/reconnect.txt');
await sb.detach();
const handle = await Sandbox.get(name);
const connected = await handle.connect();
await connected.shell('cat /tmp/reconnect.txt');
```

Observed:

```text
CREATED oma-msb-reconnect-1781184535001 ownsLifecycle false
WRITE 0 "reconnect-state\n"
DETACHED
CONNECTED oma-msb-reconnect-1781184535001 ownsLifecycle false
CONNECTED_READ 0 "reconnect-state\n"
STOPPED
REMOVED_BY_HANDLE
LEFT []
```

Interpretation:

- `handle.connect()` works for an already-running detached sandbox;
- it does not take lifecycle ownership;
- `handle.remove()` cleans a stopped sandbox cleanly.

Earlier API misuse to avoid: `handle.start()` returns the live `Sandbox`. Do not
discard it and then immediately call `handle.connect()` on the stale stopped
handle.

## Killed/Crashed Cleanup

Probe:

```js
await sb.kill();
await Sandbox.remove(name);
```

Observed:

```text
SANDBOX_KILLED oma-msb-kill-1781184495027
REMOVE_AFTER_KILL removed
LIST_AFTER_KILL_REMOVE []
```

A script cleanup bug left earlier probe sandboxes in `crashed` state. Manual
cleanup showed the robust path:

```text
cleanup oma-msb-net-default-1781184435236 crashed
 stopped
 removed-handle
...
remaining []
```

Interpretation:

- killed sandboxes can be removed;
- crashed sandboxes can be cleaned by getting the handle, calling
  `stopWithTimeout(0)`, then `handle.remove()`;
- `await using` auto-dispose stops sandboxes but does not remove them; they
  remain listed as stopped until explicitly removed;
- cleanup code should prefer handle-level removal after stop/kill rather than
  assuming static removal is always enough for every state.

## Final State

Final cleanup check:

```text
remaining []
```

No microsandbox probe sandboxes were left behind.

## Verdict

Confirmed:

- streaming output works;
- command kill works;
- detached reconnect works for running sandboxes;
- default public egress and explicit deny-all/allow-all policies behave as
  expected for public destinations;
- killed/crashed cleanup is possible.

Still open:

- secret substitution;
- private-network policy denial with a better target;
- snapshots versus named volumes for pause/resume;
- port publishing;
- metrics/log stream shape.

Contract impact:

- OMA should normalize cancellation results instead of leaking provider exit
  codes like `-1`.
- OMA should set network policy explicitly; provider defaults are not the
  product contract.
- OMA cleanup should be state-aware and resource-aware: sandbox, volume/disk,
  snapshot, port, and metadata cleanup belong together.
