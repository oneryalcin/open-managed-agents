# Plan 0140 -- Alpha coding sandbox image

Status: implementation in progress on `dev/alpha-coding-sandbox-image`;
source, local Docker smoke, and local amd64/arm64 build gates pass; immutable
publication and runtime-digest promotion remain pending

Date: 2026-07-19

Tracks: [issue #200](https://github.com/oneryalcin/open-managed-agents/issues/200)

## Goal

Replace OMA's execution-minimal Alpine sandbox default with one useful,
OMA-owned alpha coding image that can run ordinary Node/npm and Python/uv
projects without a custom image. Preserve the security, provider, and
supply-chain invariants established by plan 0138.

This slice installs tools. It does **not** implicitly grant network access.
Offline remains the environment default; console presets and supported egress
onboarding remain issue #199.

## Evidence and current constraints

- `images/sandbox/Dockerfile:1-22` currently ships Alpine 3.22 with only Bash
  and ripgrep. A real pull/run of the published digest confirmed that Python,
  uv, Node, npm, Git, curl, jq, make, and a compiler are absent.
- `.github/workflows/publish-sandbox-image.yml:68-92` already builds amd64 and
  arm64, attaches BuildKit provenance/SBOM, enforces a compressed-size ceiling,
  and scans the exact published digest for CRITICAL findings.
- `src/control-plane/sessions/pi/sandbox/image.ts:7-8` owns the one immutable
  runtime digest; Docker and microsandbox deliberately share it.
- Docker currently limits the workspace to a 64 MiB tmpfs under a 384 MiB
  cgroup (`docker.ts:59-64`, `:930-946`). That cannot hold realistic
  `node_modules`, uv environments, caches, and an active runtime.
- Microsandbox currently allows 512 MiB RAM and a 1 GiB OCI upper layer
  (`microsandbox.ts:52-59`, `:995-1004`). Its named workspace volume is not the
  Docker 64 MiB tmpfs, but the memory default is still too tight for a coding
  toolchain plus model-directed builds.
- `oma doctor` only inspects whether the pinned image exists and must remain
  read-only (`scripts/oma-doctor.ts:105-132`).

Upstream evidence:

- The official Node image documents Debian/slim variants and calls out Alpine's
  musl compatibility tradeoff:
  <https://github.com/nodejs/docker-node>.
- Astral documents copying `/uv` and `/uvx` from its official image and
  recommends digest pinning:
  <https://docs.astral.sh/uv/guides/integration/docker/>.

## Decisions

### D1 -- Replace the alpha default; do not add a profile selector yet

OMA has no public compatibility obligation and the console has no reviewed
per-environment image selection boundary. Keeping a tiny image as the default
would preserve the exact alpha failure this slice exists to fix.

Therefore:

- publish one new coding image under the existing OMA sandbox package;
- replace `DEFAULT_OMA_SANDBOX_IMAGE` only after the exact new digest passes all
  release and live-provider gates;
- keep the old immutable digest available for forensic/reproducibility use, but
  do not expose it as a product profile in this slice;
- defer reviewed custom/per-environment image selection to its own security
  design.

### D2 -- Use the official Node 24 Debian trixie slim base

Pin this currently verified multi-platform base by digest:

```text
docker.io/library/node:24-trixie-slim
sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573
```

The inspected image reports Node `24.18.0` and npm `11.16.0`; the base alone is
approximately 78 MiB compressed per target platform. Debian/glibc is chosen
over Alpine/musl to reduce Python wheel and npm native-module compatibility
friction. Re-resolve the tag before implementation; changing the digest is an
explicit reviewed dependency update, never an automatic follow.

### D3 -- Pin the coding tool contract

Install exact Debian package revisions observed from the pinned base's trixie
repositories:

```text
bash=5.2.37-2+b9
ca-certificates=20250419
python3=3.13.5-1
python3-venv=3.13.5-1
python-is-python3=3.13.3-1
python3-dev=3.13.5-1
git=1:2.47.3-0+deb13u1
curl=8.14.1-2+deb13u4
jq=1.7.1-6+deb13u2
ripgrep=14.1.1-1+b4
tar=1.35+dfsg-3.1
gzip=1.13-1
unzip=6.0-29
xz-utils=5.8.1-1+deb13u1
bzip2=1.0.8-6
zip=3.0-15
file=1:5.46-5
build-essential=12.12
pkg-config=1.8.1-4
```

These are deliberate build-time assertions against Debian's live stable and
security repositories, not a claim that the Dockerfile is indefinitely
rebuildable from immutable apt snapshots. Before every image release, resolve
the current versions from the still-pinned base, review any changes, update
the assertions, build both platforms, and repeat the scan/smoke gates. A
missing pinned revision must fail the build; it must never silently float to a
different package. Moving to snapshot.debian.org can be evaluated separately
if long-term bit-for-bit rebuilds become a release requirement.

Include the native build baseline now. It supports common `node-gyp` and
Python sdist builds; it is not a promise that projects requiring extra system
libraries will compile.

Install uv by copying `/uv` and `/uvx` from Astral's pinned multi-platform
`0.11.29` image digest:

```text
ghcr.io/astral-sh/uv:0.11.29
sha256:eb2843a1e56fd9e30c7276ce1a52cba86e64c7b385f5e3279a0e08e02dd058fc
```

Do not use `curl | sh`, a mutable tag, or runtime installation.

### D4 -- Preserve runtime hardening and define writable tool state

The image remains:

- `USER 65534:65534`;
- `/workspace` workdir;
- compatible with Docker's read-only root, dropped capabilities,
  no-new-privileges, pids/memory limits, and isolated/default-deny network;
- compatible with the same Docker and microsandbox provider-owned grep
  preflight.

Set image environment so tools never expect a writable `/root` or `/home`:

```text
HOME=/workspace
XDG_CACHE_HOME=/workspace/.cache
TMPDIR=/workspace
TMP=/workspace
TEMP=/workspace
UV_CACHE_DIR=/workspace/.cache/uv
UV_PYTHON_DOWNLOADS=0
PIP_CACHE_DIR=/workspace/.cache/pip
NPM_CONFIG_CACHE=/workspace/.cache/npm
NPM_CONFIG_PREFIX=/workspace/.local
COREPACK_HOME=/workspace/.cache/corepack
PATH=<existing system PATH>:/workspace/.local/bin:/workspace/.venv/bin
```

Project dependencies, virtual environments, npm globals, caches, and temporary
build files therefore land on the disposable writable workspace while the
container's `/tmp` stays protected by the read-only root. No global
apt/npm/pip mutation is a supported runtime operation. Writable workspace paths must never precede
system paths: provider-owned operations invoke pinned guest tools such as
`rg`, `find`, and `bash`, and an agent-created executable must not shadow those
tools after provider preflight. Virtual-environment activation may prepend its
own `bin` directory for an interactive project command; provider operations
must continue to use their sanitized system-tool path.

### D5 -- Introduce a coding-capable provider resource profile

For Docker-local, change defaults to:

```text
memory: 1g
pids: 128
workspace/uploads/skills tmpfs size: 256m
outputs tmpfs: 100m (unchanged)
```

This keeps the existing conservative tmpfs accounting valid:
`256 + 256 + 100 + 256 = 868 MiB < 1 GiB`. It is intentionally a bounded
alpha profile, not an unlimited build machine. A real npm and uv smoke must fit
inside it; if it does not, adjust from measurements rather than weakening the
headroom assertion.

For microsandbox-local, change defaults to:

```text
memory: 1G
persistent named workspace: existing behavior
OCI upper size: 1G (unchanged unless measurement proves insufficient)
```

Keep CPU at one and operation timeout behavior unchanged. The public Bash tool
already supports caller-selected timeouts in seconds; smoke tests must use an
explicit bounded timeout for dependency work.

### D6 -- Raise and then tighten the image budget from measurement

The old 25 MiB ceiling described an execution-minimal Alpine image and cannot
apply to an official Node base that is already approximately 78 MiB compressed.

- Start the branch with a 300 MiB per-platform CI ceiling.
- Build both target platforms and record actual compressed and unpacked sizes.
- Before merge, tighten the ceiling to no more than 15% above the larger
  measured compressed platform size, rounded up to a whole MiB.
- Record cold-pull and warm container-start timings on available macOS/arm64;
  CI records Linux/amd64 build/smoke evidence.
- Keep issue #194's publish-before-gates limitation explicit; do not claim this
  slice fixes tag promotion ordering.

### D7 -- Publish before pinning the runtime default

1. Land or push the complete image source and smoke gates on the dev branch.
2. Publish an immutable prerelease tag from that exact branch/ref.
3. Run size, CRITICAL scan, SBOM/provenance, anonymous-pull, amd64/arm64
   manifest, and live Docker/microsandbox gates against its digest.
4. Only then update `DEFAULT_OMA_SANDBOX_IMAGE` and the associated docs/tests.

No test or runtime path may follow the prerelease tag after the digest exists.

## Implementation slices

### Slice 1 -- Image source and deterministic local smoke

Files:

- `images/sandbox/Dockerfile`
- `images/sandbox/README.md`
- new `scripts/smoke-coding-sandbox-image.mjs`
- `Makefile`
- package/scripts tests as needed

Work:

- replace the Alpine recipe with D2-D4;
- verify exact versions at build time;
- add a local smoke that asserts commands/versions, writable workspace/cache
  locations, non-root identity, read-only-root failure, local npm project
  execution, local uv project/venv execution, and existing ripgrep semantics;
- do not require public network access inside the runtime smoke; registry
  egress belongs to #199.

### Slice 2 -- Provider resource defaults and regression tests

Files:

- `src/control-plane/sessions/pi/sandbox/docker.ts`
- `src/control-plane/sessions/pi/sandbox/microsandbox.ts`
- their provider tests

Work:

- implement D5;
- pin generated Docker/msb command lines;
- prove offline/default-deny behavior is unchanged;
- prove the resource headroom assertion still rejects unsafe combinations;
- retain cleanup, timeout, file-mount, skills, glob, and grep behavior.

### Slice 3 -- Publication workflow and immutable digest

Files:

- `.github/workflows/publish-sandbox-image.yml`
- `scripts/check-oci-image-size.mjs` and tests only if the generic mechanism
  needs adjustment
- `src/control-plane/sessions/pi/sandbox/image.ts`
- `scripts/oma-doctor.ts`
- image/default tests

Work:

- apply D6;
- publish and verify D7;
- update the runtime digest only after evidence passes;
- keep `oma doctor` read-only while making its message accurately describe the
  coding image.

### Slice 4 -- Product docs and alpha proof

Files:

- `README.md`
- `docs/getting-started.md`
- `docs/dev-deployment.md`
- `ALPHA.md`
- `PARITY.md`
- `handoff.md`
- this plan and issue #200

Work:

- document exact installed tools and exclusions;
- state that image capability and network permission are separate;
- record digest, platform sizes, timings, scan result, and provider smoke;
- mark #200 complete only after a new-user session actually runs Node/npm and
  Python/uv work through the shipped default.

## Tests and acceptance criteria

### Image contract

- Docker build succeeds for `linux/amd64` and `linux/arm64`.
- `node`, `npm`, `python`, `python3`, `uv`, `uvx`, `git`, `curl`, `jq`, `rg`,
  archive tools, `cc`, `c++`, `make`, and `pkg-config` are present with pinned
  expected versions.
- Runtime UID/GID is `65534:65534` and `/workspace` is the working directory.
- With Docker's real read-only root, writing outside approved mounts fails.
- npm and uv cache/global/project state stays under `/workspace`.
- `/tmp` remains unwritable while `mktemp` and native builds succeed through
  the workspace-backed `TMPDIR`/`TMP`/`TEMP` contract.

### Coding proof

- A local fixture package runs `npm install`/`npm test` without global writes.
- A local Python fixture creates `.venv` and runs through `uv` without managed
  Python downloads.
- One small C-backed Node or Python fixture compiles under the native build
  baseline; the exact fixture is committed and deterministic.
- A network-disabled session cannot reach a controlled external endpoint.
- Registry-backed install proofs are completed with #199's egress presets; the
  image PR must not bypass the OMA proxy to prove them. The image PR may merge
  with #200 still open; #200 closes only after #199 supplies and verifies the
  egress-enabled npm/Python registry path.

### Provider and security regression

- Docker and microsandbox default to the same immutable coding-image digest.
- Provider grep semantic preflight and real grep smoke remain green.
- Hostile workspace executables named `rg`, `find`, `cat`, and `bash` cannot
  shadow the system tools used by provider-owned grep/glob/read/bash paths.
- Existing upload/output/skill ownership and tamper tests remain green.
- Workspace/resource defaults match D5 and unsafe tmpfs/memory combinations
  still fail before container creation.
- Docker/microsandbox cancellation and disposal leave no residual resources.
- Full typecheck and test suite pass.

### Release evidence

- Manifest contains exactly the supported amd64 and arm64 runtime platforms
  plus any attestations.
- Final compressed-size ceiling is tightened from the measured result.
- CRITICAL scan reports zero findings under the existing policy.
- BuildKit provenance and SBOM are attached; GitHub attestation behavior is
  reported honestly for repository visibility/ownership.
- An empty Docker credential store can pull and run the digest.
- Cold-pull and warm-start measurements are recorded, not estimated.

## Risks and mitigations

- **Image bloat:** measure before pinning; tighten the budget; document transfer
  and unpacked sizes.
- **Python 3.13 ecosystem gaps:** glibc reduces wheel friction, but tests and
  docs must not promise universal package compatibility. Revisit a separately
  pinned Python 3.12 only if real alpha fixtures fail.
- **Package pin aging:** updates are reviewed digest/version changes with smoke
  and scan evidence; live apt repositories make a stale pin fail the build,
  which triggers an explicit re-resolution rather than a silent float.
- **Expanded attack surface:** retain non-root/read-only/cap-drop/no-new-privs,
  exact-digest scanning, default-deny networking, and provider cleanup tests.
- **Workspace exhaustion:** raise to the bounded D5 profile and add exact-limit
  failure tests; do not silently switch to an unbounded host bind mount.
- **Conflating tools with egress:** image tests stay offline; registry access is
  proven only through #199's proxy-policy work.

## Stop conditions

Do not update the runtime default digest or close #200 if any of these remain:

- only one architecture builds;
- Node/npm or Python/uv require root/global writes;
- real Docker read-only-root or default-deny behavior regresses;
- size/scan/provenance evidence is missing;
- the published digest has not passed real Docker and microsandbox smoke;
- docs imply network access is included with the image.
