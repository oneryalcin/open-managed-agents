# 0108 microsandbox production-behavior probe

Date: 2026-06-11

This is the final scratch probe for the microsandbox provider-evaluation arc.
It checks the remaining production-shaped behavior from plan 0107:

- secret placeholder substitution;
- private-network denial with a controlled target;
- snapshot versus named-volume parking;
- port publishing;
- metrics and log stream shape.

No production OMA provider code was changed.

## Environment

- Host: macOS arm64, Darwin 25.4.0
- Host LAN IP used for controlled private target: `192.168.1.248`
- Node: v25.8.2
- microsandbox npm package: 0.5.6
- Probe temp project: `/tmp/oma-msb-sdk.IAr6G3`

Final cleanup checks returned:

```text
sandboxes []
volumes []
snapshots []
```

## Snapshot Versus Named Volume Parking

Snapshot creation worked for a stopped sandbox:

```text
SNAPSHOT_WRITE {"code":0,"stdout":"rootfs-snapshot-state\n","stderr":""}
SNAPSHOT_CREATE {"ok":true,"keys":["inner"],"value":{"inner":{}}}
SNAPSHOT_RESTART_READ {"code":0,"stdout":"rootfs-snapshot-state\n","stderr":""}
```

Snapshot restore into a new sandbox also worked:

```text
SNAPSHOT_RESTORE_WRITE {"code":0,"stdout":"snapshot-restore-state\n","stderr":""}
SNAPSHOT_RESTORE_SNAPSHOT {"path":"/Users/mehmetoneryalcin/.microsandbox/snapshots/oma-prod-snap-artifact-1781186529383","digest":"sha256:b64aeabe89eb92caa5f8078ba124d9194839728a2f2c322d76de9c5ace384af5","sourceSandbox":"oma-prod-snap-source-1781186529383"}
SNAPSHOT_RESTORE_CLONE_READ {"code":0,"stdout":"snapshot-restore-state\n","stderr":""}
SNAPSHOT_RESTORE_REMOVED true
FINAL_RESIDUE {"sandboxes":[],"snapshots":[]}
```

Named volume restart also worked:

```text
VOLUME_WRITE {"code":0,"stdout":"volume-parking-state\n","stderr":""}
VOLUME_RESTART_READ {"code":0,"stdout":"volume-parking-state\n","stderr":""}
```

Interpretation:

- snapshots are usable as a stopped-sandbox capture and clone/restore primitive;
- named volumes are simpler for normal `requires_action` parking because they
  avoid creating and managing separate snapshot artifacts;
- snapshots are more interesting for fork/restore/export workflows than for the
  first provider implementation.

## Port Publishing

Probe: publish guest TCP `8080` to a random host port, run a tiny `nc` HTTP
server in the guest, fetch from the host, then stop/remove the sandbox and fetch
again.

Observed:

```text
PORT_PUBLISH_FETCH {"hostPort":18805,"fetchResult":{"ok":true,"status":200,"body":"msb-ok\n"}}
PORT_PUBLISH_AFTER_CLEANUP {"hostPort":18805,"afterCleanup":{"ok":false,"name":"TypeError","message":"fetch failed"}}
```

Interpretation:

- guest-to-host TCP publishing works;
- the host port closed after sandbox cleanup;
- provider implementation still needs collision handling and explicit port
  ownership metadata.

## Metrics and Logs

Probe: run a command that writes stdout and stderr, then call `metrics()`,
`logs()`, and `logStream({ follow: false })`.

Observed:

```text
OBS_EXEC {"code":0,"stdout":"log-one\n","stderr":"err-one\n"}
OBS_METRICS {"cpuPercent":0,"vcpuTimeNs":0,"memoryBytes":0,"memoryAvailableBytes":null,"memoryHostResidentBytes":null,"memoryLimitBytes":536870912,"diskReadBytes":0,"diskWriteBytes":0,"netRxBytes":0,"netTxBytes":0,"uptimeMs":8,"timestamp":"2026-06-11T13:59:32.860Z"}
OBS_LOGS [{"timestamp":"2026-06-11T13:59:33.035Z","source":"stdout","sessionId":1,"data":{"0":108,"1":111,"2":103,"3":45,"4":111,"5":110,"6":101,"7":10},"cursor":"AeG2wQcAAAAAkwAAAAAAAAA="},{"timestamp":"2026-06-11T13:59:33.035Z","source":"stderr","sessionId":1,"data":{"0":101,"1":114,"2":114,"3":45,"4":111,"5":110,"6":101,"7":10},"cursor":"AeG2wQcAAAAA2AAAAAAAAAA="}]
OBS_LOG_STREAM [{"timestamp":"2026-06-11T13:59:33.035Z","source":"stdout","sessionId":1,"data":{"0":108,"1":111,"2":103,"3":45,"4":111,"5":110,"6":101,"7":10},"cursor":"AeG2wQcAAAAAkwAAAAAAAAA="},{"timestamp":"2026-06-11T13:59:33.035Z","source":"stderr","sessionId":1,"data":{"0":101,"1":114,"2":114,"3":45,"4":111,"5":110,"6":101,"7":10},"cursor":"AeG2wQcAAAAA2AAAAAAAAAA="}]
```

Interpretation:

- metrics shape is usable for OMA observability;
- logs and log streams include timestamp, source, session id, byte data, and
  cursor;
- OMA would need a small byte-decoding/normalization layer before surfacing
  these as API/runtime events.

## Private-Network Policy

Probe: run a controlled HTTP server on the host LAN IP, then connect from
microsandbox under default policy, `NetworkPolicy.none()`, and
`NetworkPolicy.allowAll()`.

Observed:

```text
PRIVATE_SERVER {"host":"192.168.1.248","port":19286}
PRIVATE_DEFAULT {"code":0,"stdout":"reach-fail\n","stderr":"wget: can't connect to remote host (192.168.1.248): Connection refused\n"}
PRIVATE_NONE {"code":0,"stdout":"reach-fail\n","stderr":"wget: can't connect to remote host (192.168.1.248): Connection refused\n"}
PRIVATE_ALLOWALL {"code":0,"stdout":"host-private-ok /probe\n\\nreach-ok\n","stderr":""}
FINAL_RESIDUE []
```

Interpretation:

- default policy did not reach the private/LAN host target;
- `NetworkPolicy.none()` also did not reach it;
- `NetworkPolicy.allowAll()` did reach it;
- this confirms the default public-only posture with a controlled target.

## Secret Placeholder Substitution

Two controlled HTTPS echo attempts were made against a local self-signed HTTPS
server.

Shorthand `secretEnv` showed that the real secret did not enter the guest, but
the request header arrived empty:

```text
SECRET_ENV_VISIBLE {"code":0,"stdout":"$MSB_OMA_PROBE_SECRET","stderr":"","containsSecret":false}
SECRET_ECHO {"code":0,"stdout":"{\"url\":\"/echo\",\"headers\":{\"host\":\"192.168.1.248:19588\",\"user-agent\":\"Wget\",\"accept\":\"*/*\",\"connection\":\"close\",\"x-oma-secret\":\"\"}}","stderr":"","stdoutContainsSecret":false,"stdoutContainsPlaceholder":false}
SECRET_SERVER_REQUESTS [{"url":"/echo","xOmaSecret":"","containsSecret":false}]
```

Explicit secret builder with `injectHeaders`, `injectBody`, and `injectQuery`
showed the guest env contains only the placeholder, but the controlled HTTPS
server still received the placeholder rather than the real secret:

```text
SECRET_ENV_VISIBLE {"code":0,"stdout":"OMA_SECRET_PLACEHOLDER_TOKEN","stderr":"","containsSecret":false,"containsPlaceholder":true}
SECRET_ECHO {"code":0,"stdout":"{\"url\":\"/echo?q=OMA_SECRET_PLACEHOLDER_TOKEN\",\"headers\":{\"host\":\"192.168.1.248:19908\",\"user-agent\":\"Wget\",\"accept\":\"*/*\",\"connection\":\"close\",\"x-oma-secret\":\"OMA_SECRET_PLACEHOLDER_TOKEN\",\"content-type\":\"application/x-www-form-urlencoded\",\"content-length\":\"28\"},\"body\":\"OMA_SECRET_PLACEHOLDER_TOKEN\"}","stderr":"","stdoutContainsSecret":false,"stdoutContainsPlaceholder":true}
SECRET_SERVER_REQUESTS [{"url":"/echo?q=OMA_SECRET_PLACEHOLDER_TOKEN","xOmaSecret":"OMA_SECRET_PLACEHOLDER_TOKEN","body":"OMA_SECRET_PLACEHOLDER_TOKEN","headerContainsSecret":false,"bodyContainsSecret":false,"urlContainsSecret":false,"anyPlaceholder":true}]
```

Enabling TLS interception for the high-port self-signed local server failed
before a request reached the echo server:

```text
SECRET_ECHO {"code":0,"stdout":"","stderr":"wget: error getting response\n","stdoutContainsSecret":false,"stdoutContainsPlaceholder":false}
SECRET_SERVER_REQUESTS []
```

Interpretation:

- the real secret did not enter guest-visible env or request output in these
  probes;
- placeholder delivery is confirmed;
- end-to-end placeholder substitution is **not** confirmed;
- a production provider must not claim microsandbox secret proxy support until a
  provider-recommended or production-equivalent HTTPS echo test proves
  substitution end to end.

## Verdict

Passed:

- snapshot create and restore;
- named-volume parking;
- port publishing and cleanup;
- metrics shape;
- logs/log-stream shape;
- controlled private-network denial under default/none and reachability under
  allow-all.

Not passed:

- secret placeholder substitution. It remains the only blocker in this probe
  set. A follow-up decisive probe with plain HTTP plus HTTPS interception still
  did not prove substitution; see
  `scratch/0109-microsandbox-secret-decisive-probe.md`.

Product implication:

- microsandbox remains a strong self-hosted no-Kubernetes provider candidate;
- first implementation should use explicit volumes/disks for session workspace
  durability;
- snapshots should be treated as fork/export/restore capability, not the default
  parking mechanism;
- OMA should set network policy explicitly rather than inheriting provider
  defaults;
- secrets should either be excluded from the first microsandbox provider slice or
  gated behind a passing substitution probe.
