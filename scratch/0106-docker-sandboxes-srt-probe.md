# 0106 Docker Sandboxes and sandbox-runtime probe

Date: 2026-06-11

This is a scratch evidence note for issue #121. It probes two near-term local
sandbox candidates without changing OMA runtime code.

Update after Docker authentication: the Docker Sandboxes lifecycle smoke passed
end to end. See "Authenticated lifecycle smoke" below.

## Environment

- Host: macOS arm64, Darwin 25.4.0
- Docker: client/server 29.4.0, via OrbStack
- Node: v25.8.2
- npx: 11.11.1
- Docker Sandboxes: `sbx version: v0.32.0 55580366449bcfebfc1787b9944284cf64c856d7`
- Anthropic sandbox-runtime npm package: `@anthropic-ai/sandbox-runtime` 0.0.54
- Anthropic sandbox-runtime CLI version output: `0.0.1`

The `srt` package version and CLI version output disagree. Treat this as
packaging friction, not as a functional blocker.

## Docker Sandboxes (`sbx`)

### Install and command surface

Initial install failed because Homebrew refused to load Docker tap metadata under
tap-trust enforcement:

```text
Error: Refusing to load cask docker/tap/sbx@nightly from untrusted tap docker/tap.
```

After trusting Docker's tap with `brew trust docker/tap`, installation succeeded:

```text
==> Installing Cask sbx
==> Linking Binary 'sbx' to '/opt/homebrew/bin/sbx'
sbx was successfully installed
```

`sbx --help` exposes the expected provider-grade operations:

- `create`
- `exec`
- `cp`
- `stop`
- `run`
- `rm`
- `ls`
- `ports`
- `policy`
- `secret`
- `template`

The lifecycle and file-transfer help is directly relevant to OMA:

```text
sbx create [flags] AGENT PATH [PATH...]
sbx exec [flags] SANDBOX COMMAND [ARG...]
sbx cp [flags] SRC DST
sbx stop SANDBOX [SANDBOX...]
```

`sbx exec --help` states:

```text
Execute a command in a sandbox. If the sandbox is stopped, it is started first.
```

`sbx stop --help` states:

```text
Stopped sandboxes retain their state and can be restarted with "sbx run".
```

### Auth requirement

The first real command is blocked before sandbox creation:

```text
$ sbx ls
ERROR: Not authenticated to Docker

Sign in with: sbx login
```

`sbx login --help` supports non-interactive username/password or access-token
login:

```text
--username string   Docker username for non-interactive login
--password-stdin    Read password or access token from stdin
```

I did not run an interactive login or use Docker credentials in this probe.

After the user authenticated locally, `sbx ls` succeeded:

```text
No sandboxes found.
Launch one: sbx run claude
```

This means authentication is required even before listing or creating
sandboxes. That is not only probe friction; it is a product-posture caveat for
any self-hosted OMA tier built on Docker Sandboxes.

### Authenticated lifecycle smoke

After authentication, a named `shell` sandbox passed the OMA-shaped lifecycle
smoke:

- create a sandbox with a temporary mounted workspace;
- execute a command inside the sandbox;
- read a host-mounted input file;
- write sandbox-local state under `/tmp/oma-state`;
- write a file back to the mounted workspace;
- copy host to sandbox with `sbx cp`;
- copy sandbox to host with `sbx cp`;
- stop the sandbox;
- verify `sbx ls` reports `stopped`;
- resume implicitly with `sbx exec`;
- verify sandbox-local state survived stop/resume;
- remove the sandbox with `sbx rm --force`;
- verify `sbx ls` is clean.

Key output:

```text
✓ Created sandbox 'oma-probe-1781167008'
Workspace: /tmp/oma-sbx-probe.gcqRyt (direct mount)
Agent: shell

SANDBOX                AGENT   STATUS    PORTS   WORKSPACE
oma-probe-1781167008   shell   running           /tmp/oma-sbx-probe.gcqRyt

persisted-oma-probe-1781167008
copied-from-host

Sandbox 'oma-probe-1781167008' stopped
SANDBOX                AGENT   STATUS    PORTS   WORKSPACE
oma-probe-1781167008   shell   stopped           /tmp/oma-sbx-probe.gcqRyt

Sandbox oma-probe-1781167008 started successfully
persisted-oma-probe-1781167008
copied-from-host

Sandbox 'oma-probe-1781167008' removed
No sandboxes found.
Launch one: sbx run claude
```

### Verdict

Docker Sandboxes remains a valid first local provider candidate because the CLI
surface maps closely to OMA's provider needs:

- create a named workspace-backed sandbox
- execute commands in an existing sandbox
- copy files in and out
- stop without removal
- restart stopped sandboxes
- remove a sandbox

The OMA-shaped local lifecycle is now empirically proven for the shell template:
create, exec, copy in, copy out, stop, implicit resume via `exec`, state
survival, and remove all work.

The remaining concern is product posture. Because Docker authentication is
required before any sandbox can be used, Docker Sandboxes should be treated as a
strong local developer-tier candidate, not automatically as OMA's self-hosted
production substrate. Before production implementation, decide whether a Docker
account/licensing dependency is acceptable for the target deployment mode.

## Anthropic sandbox-runtime (`srt`)

### Package and framing

The npm package describes itself as:

```text
Anthropic Sandbox Runtime (ASRT) - A general-purpose tool for wrapping security boundaries around arbitrary processes
```

The README states that it uses native OS sandboxing primitives:

- macOS: `sandbox-exec`
- Linux: `bubblewrap`

That matches the plan's classification: `srt` is a policy wrapper for a process,
not a complete session/workspace provider.

### Simple command

Command:

```bash
npx --yes @anthropic-ai/sandbox-runtime -c 'pwd && echo srt-ok'
```

Result:

```text
/Users/mehmetoneryalcin/dev/personal/open-managed-agents
srt-ok
```

### Filesystem restrictions

Test config:

```json
{
  "network": { "allowedDomains": [], "deniedDomains": [] },
  "filesystem": {
    "denyRead": ["/tmp/oma-srt-probe.sKvHCC/outside"],
    "allowRead": ["/tmp/oma-srt-probe.sKvHCC/work"],
    "allowWrite": ["/tmp/oma-srt-probe.sKvHCC/work"],
    "denyWrite": []
  }
}
```

Write inside the allowed workspace succeeded:

```text
write-inside: allowed
```

Write outside the allowed workspace was blocked and did not create the file:

```text
write-outside: blocked
/opt/homebrew/bin/bash: line 1: /tmp/oma-srt-probe.sKvHCC/outside/blocked.txt: Operation not permitted
outside-file-exists: no
```

Read outside the allowed workspace was blocked:

```text
read-outside: blocked
cat: /tmp/oma-srt-probe.sKvHCC/outside/secret.txt: Operation not permitted
```

### Network restrictions

With an empty network allowlist, `curl -I http://example.com` returned an HTTP
response and exit code 0, but the response was the sandbox proxy denying the
request:

```text
HTTP/1.1 403 Forbidden
X-Proxy-Error: blocked-by-allowlist
```

For HTTPS with debug enabled, the denial is explicit:

```text
[SandboxDebug] No matching config rule, denying: example.com:443
[SandboxDebug] Connection blocked to example.com:443
curl: (56) CONNECT tunnel failed, response 403
```

With `allowedDomains: ["example.com"]`, both HTTP and HTTPS reached the domain:

```text
allow-http: HTTP/1.1 200 OK
allow-https: HTTP/1.1 200 Connection Established
```

Note for future tests: `curl -I` may exit 0 for a sandbox-generated HTTP 403.
Use `curl --fail` or inspect headers when asserting network denial.

### Verdict

`srt` is useful for constraining subprocesses in a local runner:

- no container or VM required
- filesystem write allowlist works
- read deny-and-reallow works
- network allowlist works through a host proxy
- applies to the process tree rather than one command only

It is not a full OMA sandbox provider by itself:

- no durable session/workspace lifecycle
- no private Linux userland per session
- no provider-owned file materialization protocol
- no stop/resume/parking API
- no output collection API
- no remote execution or multi-host placement

Use it as a possible hardening layer around a local subprocess provider or local
MCP/tool execution, not as a replacement for Docker Sandboxes, Kubernetes, or a
remote sandbox provider.

## Implications for OMA

1. Keep Docker Sandboxes first in the local provider queue for the developer
   tier. The authenticated lifecycle proof passed.
2. Keep `srt` in the "policy wrapper" bucket. It can complement a provider, but
   it does not satisfy OMA's session provider contract alone.
3. Do not add production provider abstractions yet. The next useful artifact is
   a typed provider-contract audit against the operations OMA already needs:
   create, prepare, exec/stream, park, resume, copy resources, collect outputs,
   interrupt, archive/delete, and cleanup.
4. Add account/licensing/offline behavior to the provider comparison matrix. The
   Docker account dependency may disqualify `sbx` from the self-hosted
   production tier even if it remains excellent for local developer sandboxes.
