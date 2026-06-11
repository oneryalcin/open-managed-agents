# 0109 microsandbox secret decisive probe

Date: 2026-06-11

This scratch probe isolates microsandbox secret placeholder substitution after
the 0108 probe left the failure ambiguous.

Conditions tested:

- controlled plain HTTP echo server;
- controlled HTTPS echo server with self-signed local cert;
- TLS interception enabled for the HTTPS test;
- test HTTPS port included in `interceptedPorts`;
- `verifyUpstream(false)` set;
- test cert also passed through `upstreamCaCert(...)`;
- explicit secret builder with `placeholder(...)`, `injectHeaders(true)`,
  `injectBody(true)`, and `injectQuery(true)`;
- final cleanup for sandboxes, volumes, and snapshots.

## Environment

- Host: macOS arm64, Darwin 25.4.0
- Host LAN IP used for controlled echo targets: `192.168.1.248`
- Node: v25.8.2
- microsandbox npm package: 0.5.6
- Probe temp project: `/tmp/oma-msb-sdk.IAr6G3`

Final cleanup check:

```text
sandboxes []
volumes []
snapshots []
```

## Controlled Plain HTTP

Probe setup:

```js
.network(n => n
  .policy(NetworkPolicy.allowAll())
  .secret(s => s
    .env('OMA_PROBE_SECRET')
    .value(secret)
    .placeholder(placeholder)
    .allowHost(host)
    .requireTlsIdentity(false)
    .injectHeaders(true)
    .injectBody(true)
    .injectQuery(true)))
```

Observed:

```text
HTTP_SECRET_ENV {"code":0,"stdout":"OMA_SECRET_PLACEHOLDER_TOKEN","stderr":"","containsSecret":false,"containsPlaceholder":true}
HTTP_SECRET_ECHO {"code":0,"stdout":"{\"label\":\"http\",\"url\":\"/echo?q=OMA_SECRET_PLACEHOLDER_TOKEN\",\"headers\":{\"host\":\"192.168.1.248:20165\",\"user-agent\":\"Wget\",\"accept\":\"*/*\",\"connection\":\"close\",\"x-oma-secret\":\"OMA_SECRET_PLACEHOLDER_TOKEN\",\"content-type\":\"application/x-www-form-urlencoded\",\"content-length\":\"28\"},\"body\":\"OMA_SECRET_PLACEHOLDER_TOKEN\"}","stderr":"","stdoutContainsSecret":false,"stdoutContainsPlaceholder":true}
HTTP_SERVER_REQUESTS [{"url":"/echo?q=OMA_SECRET_PLACEHOLDER_TOKEN","header":"OMA_SECRET_PLACEHOLDER_TOKEN","body":"OMA_SECRET_PLACEHOLDER_TOKEN","urlContainsSecret":false,"headerContainsSecret":false,"bodyContainsSecret":false,"containsPlaceholder":true}]
```

Interpretation:

- the real secret did not enter guest-visible env;
- the guest received the placeholder;
- the HTTP echo server received the placeholder unchanged in query, header, and
  body;
- no substitution occurred in this controlled plain-HTTP test.

## Controlled HTTPS With Interception

Probe setup:

```js
.network(n => n
  .policy(NetworkPolicy.allowAll())
  .tls(t => t
    .verifyUpstream(false)
    .interceptedPorts([httpsPort])
    .upstreamCaCert(certPath))
  .secret(s => s
    .env('OMA_PROBE_SECRET')
    .value(secret)
    .placeholder(placeholder)
    .allowHost(host)
    .requireTlsIdentity(false)
    .injectHeaders(true)
    .injectBody(true)
    .injectQuery(true)))
```

Observed:

```text
HTTPS_SECRET_INTERCEPT_ENV {"code":0,"stdout":"OMA_SECRET_PLACEHOLDER_TOKEN","stderr":"","containsSecret":false,"containsPlaceholder":true}
HTTPS_SECRET_INTERCEPT_ECHO {"code":0,"stdout":"","stderr":"wget: error getting response\n","stdoutContainsSecret":false,"stdoutContainsPlaceholder":false}
HTTPS_SERVER_REQUESTS []
```

Interpretation:

- the real secret again did not enter guest-visible env;
- the guest received the placeholder;
- with TLS interception enabled and the high test port included, the request
  failed before the controlled HTTPS echo server saw it;
- no end-to-end substitution was proven.

## Verdict

Secret placeholder delivery is verified. Secret substitution is not passing in
the controlled local probes.

Upstream context checked after the probe:

- [superradcompany/microsandbox#646](https://github.com/superradcompany/microsandbox/issues/646)
  is open and states that secret substitution only runs in the TLS interception
  path, so plain HTTP forwards the placeholder verbatim. That matches this
  probe's plain-HTTP result.
- [superradcompany/microsandbox#752](https://github.com/superradcompany/microsandbox/issues/752)
  and [#769](https://github.com/superradcompany/microsandbox/issues/769)
  document open proxy/tunnel cases where the inner TLS request remains opaque to
  the substitution layer.
- [superradcompany/microsandbox#969](https://github.com/superradcompany/microsandbox/issues/969)
  documents an open TLS-interception failure mode with secrets on Linux.

These upstream issues reinforce the OMA decision: secret substitution is not a
safe first-slice dependency.

For OMA:

- exclude microsandbox secret proxy support from the first provider slice;
- do not advertise provider-side secret substitution;
- revisit only with upstream guidance or a production-equivalent HTTPS echo
  harness that demonstrates query/header/body substitution end to end.
