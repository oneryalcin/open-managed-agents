# just-bash prior art notes

Date: 2026-06-06

Purpose: evaluate [`vercel-labs/just-bash`](https://github.com/vercel-labs/just-bash)
as prior art for OMA's sandbox execution plane. Two questions:

1. Could it be (or seed) an OMA sandbox provider?
2. What design, if any, is borrowable independent of adopting the code?

This is a sandbox/threat-model prior-art pass, adjacent to the
[deployment hardening plan](../plans/0103-deployment-hardening.md) and
[threat model](../threat-model.md). It is not a provider proposal.

Source: cloned at pinned commit `9481331`
(`packages/just-bash` README + `THREAT_MODEL.md`, read 2026-06-06).

## Scope

Reviewed for four questions only:

1. isolation model (where is the wall, and what happens on breach);
2. execution fidelity (what real work an agent can actually do);
3. filesystem and network/secret model;
4. fit against OMA's harness-vs-compute trust boundary.

Not reviewed: parser/coreutils correctness, npm packaging, browser bundle size.

## Verdict

**High-value prior art. Two pieces borrowable now. Not OMA's primary sandbox.**

`just-bash` is bash re-implemented in TypeScript (~90 coreutils, optional
CPython-on-WASM and QuickJS) over a pluggable virtual filesystem. Isolation
comes from being a pure interpreter with no host syscalls, not from a container.

- The **network egress + boundary credential-injection** model is a working
  implementation of OMA's "secrets stay outside the sandbox" north star and is
  borrowable as design regardless of whether the code is ever used.
- Real filesystem backends (overlay / read-write / mountable RO+RW) make a
  future **lightweight / no-Docker provider** more viable than a pure in-memory
  toy would be.
- It cannot be OMA's primary coding sandbox: no real native toolchain
  (`pip`/`npm`/`gcc`/`git`/arbitrary binaries), and it runs **in-process**,
  which inverts OMA's trust boundary (a sandbox escape lands in the control
  plane, not in a container).

## Findings by dimension

### What it is

A `Bash` class: `new Bash(opts).exec("grep ... | jq ...")`. Each `exec()` gets
isolated shell state (env/functions/cwd reset between calls); the filesystem
persists across calls. ~90 commands re-implemented in TS — coreutils plus
`awk`, `sed`, `grep`/`rg`, `jq`, `sqlite3`, `yq`, `xan` (CSV), `tar`, `gzip`.
Optional real interpreters: `python3` (CPython via WASM) and `js-exec`
(JavaScript/TypeScript via QuickJS), each opt-in behind a flag. Runs anywhere
JS runs — node, browser, edge/serverless.

### Isolation model — the wall is around the language

Container providers put the wall around the OS (namespaces), the kernel
(gVisor), or hardware (microVM). `just-bash` puts it around the **language**:
there are no real syscalls, so a script cannot reach the host because there is
nothing to reach. The `THREAT_MODEL.md` is correspondingly about JS-level
escapes — prototype pollution, dynamic `import()`, `globalThis` reassignment,
pre-captured references — not container breakout.

The consequence that matters for OMA: a breach of a *language* wall drops the
attacker **inside the host JS process**. There is no second wall. See
"what not to copy" below.

### Filesystem — real, mountable, not in-memory-only

Four backends:

- `InMemoryFs` (default) — pure virtual.
- `OverlayFs` — copy-on-write over a real directory; reads from disk, writes
  stay in memory.
- `ReadWriteFs` — direct read/write to a real directory.
- `MountableFs` — mount a read-only knowledge base and a read-write workspace
  at different paths in one namespace.

`MountableFs` (RO inputs + RW workspace) is the same shape as OMA's Docker-local
tmpfs mounts. The README explicitly warns to keep guest-writable roots separate
from trusted runtime code — the same lexical-boundary discipline OMA enforces.

### Network egress + secret injection — the headline borrowable

Network is **default-deny**. When enabled, the model is:

- allow-list by **origin + path prefix** (exact scheme/host/port match);
- `GET`/`HEAD` only unless `allowedMethods` opts into more;
- redirects to non-allowed URLs blocked, allow-list re-evaluated per redirect;
- **credentials injected at the fetch boundary in host-land**, overriding any
  header the script sets — so the secret never enters the sandbox.

`curl` is a host-implemented command; the host process performs the real fetch
on the script's behalf, gated by the allow-list. This is the
**egress-proxy secret-injection** pattern OMA flagged in the
[Gemini sandbox note](../references.md#related-projects-evaluated-not-used) and that the custom-tool / secrets-outside-
sandbox thesis depends on — here it is shipped and concrete. It is also a
*stronger* posture than Docker-local's blunt `--network none` for the common
"agent needs the GitHub API but must never see the token" case: controlled,
credentialed egress instead of all-or-nothing.

### Toolchain fidelity ceiling — the load-bearing limit

`python3` and `js-exec` are sandboxed interpreters (CPython-WASM, QuickJS with a
64 MB cap and timeout), not a real Linux userland. An agent **cannot**:

- `pip install` a native wheel, `npm install`, or pull arbitrary deps;
- `git clone`, run `gcc`/`make`, or execute arbitrary binaries.

So "build and test this real repo with its dependencies" is out of reach. This
is why it cannot be the primary sandbox for a coding-agent platform whose north
star is real Linux execution (Anthropic Managed Agents give real sandboxes).
The `js-exec` Node-compat surface includes `child_process.execSync`/`spawnSync`,
but those route back through the simulated environment, not real host processes.

### Tool-invocation hook

`js-exec` scripts can call host-defined tools through a global `tools` proxy
when `javascript.invokeTool` is provided (`(path, argsJson) => resultJson`).
The hook is framework-agnostic — MCP, Anthropic tool-use, raw maps. Relevant to
OMA's custom-tool round-trip model as a pattern for exposing host tools into a
sandboxed runtime without giving the sandbox the host objects directly.

### Threat-model document as a template

`THREAT_MODEL.md` (~32 KB) is structured: threat actors → trust assumptions →
trust boundaries → attack-surface inventory → known gaps & residual risks →
defense-layer summary → scenarios with explicit verdicts → future hardening.
OMA's `threat-model.md` is newer and lighter; this is a worked template for the
attack-surface-inventory and residual-risk discipline, regardless of the code.

## OMA implications

- The egress allow-list + boundary credential-injection is a direct blueprint
  for OMA's secret-egress design. Borrowable now, independent of any provider
  decision. Cross-link from `threat-model.md` and any future egress ADR.
- A `simulated` / `wasm` `SandboxProvider` is a plausible **future** tier for
  the no-Docker / edge / serverless deployment story and for text/data/API-heavy
  tool-use (a large fraction of real agent tool calls are `grep`/`sed`/`jq`/
  `sqlite`/`curl`, all of which it handles). This is the niche open-ma fills
  with Cloudflare Workers + Containers.
- Reinforces the isolation taxonomy for the deployment-hardening docs (see
  appendix table): `just-bash` anchors the lightweight end of the curve.

## What not to copy

- **Do not run it in-process as OMA's sandbox.** OMA's whole thesis is that
  untrusted compute stays out of the trusted control-plane process. `just-bash`
  executes in the host process; its own threat model admits residual JS-escape
  risks; a breach lands in the box that holds the secrets and the event log. If
  OMA ever adopts it, run it inside an isolate/worker/container — which erodes
  the "zero-infra" appeal it is otherwise prized for.
- **Do not treat it as a coding sandbox.** The missing native toolchain is a
  hard ceiling, not a gap to patch.
- **Do not let it displace the remote real-Linux plan.** Modal/gVisor or
  k8s+kata/Firecracker remain the production answer for real software work;
  `just-bash` is a different point on the curve, not a replacement.

## Cross-cutting lessons

### Inject credentials at the egress boundary, never into the sandbox

The cleanest expression of secrets-outside-sandbox: the host performs the fetch
and overrides auth headers at the boundary, re-checked on every redirect. Adopt
this shape for OMA egress whatever the provider.

### Match the wall to the threat, and count the walls behind it

Choosing an isolation tier is choosing where the wall sits *and* what is behind
it if the wall fails. A language wall with the control plane behind it is a
different risk than a container wall with a host behind it. State the second
wall explicitly in provider docs.

### A high-fidelity simulator is still a simulator

Real FS mounts and credentialed egress raise fidelity a lot, but the toolchain
ceiling is categorical. Fidelity that stops at "no real binaries" is the wrong
tool for "compile and test a repo" no matter how complete the coreutils are.

## Recommendation

1. **Borrow the egress design now** — capture the allow-list + boundary
   credential-injection (origin+path match, method restriction, redirect
   re-evaluation, host-land header override) as the reference shape for OMA's
   secret-egress model. This is the single most valuable artifact and applies to
   work OMA will do regardless of `just-bash`.
2. **File a backlog issue** for a future lightweight `simulated`/`wasm` sandbox
   provider behind the existing `SandboxProvider` interface — explicitly future,
   not foundation work, and explicitly run inside an isolate per "what not to
   copy."
3. **Do not build a provider now.** OMA is mid-foundation (single-node durable
   storage); a new provider is out of scope until that lands.
4. Cross-link this note from `threat-model.md` (egress pattern, isolation
   taxonomy) and `references.md`.
