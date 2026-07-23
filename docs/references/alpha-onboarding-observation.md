# Public Alpha Onboarding Observation Protocol

This file records the human evidence gate for OMA's public npm onboarding path.
It is a protocol and results template until real observations are run. Do not
fill the results table with simulated data.

The source-checkout flow remains an advanced diagnostic path in
[Getting Started](../getting-started.md); it is not the public three-minute SLO.

## Goal

Validate that a new user can run one public command and reach an authenticated,
credential-backed starter session in the OMA console within three minutes,
without copying workspace keys or needing undocumented intervention.

## Participants

Use at least three participants before removing the public-preview caveat:

- participants must not be core OMA maintainers;
- include macOS and Linux when practical;
- record Node version, operating system/architecture, Docker-compatible runtime,
  browser, package version, and whether prior OMA state existed;
- never record credentials, raw keys, bootstrap nonces, or durable workspace IDs.

## Gated Scenario -- Public Warm Path

Target: every successful gated run completes in 180 seconds or less.

Starting state:

- Node.js 22.19 or newer is available;
- Docker or another supported Docker-compatible daemon is running;
- the pinned OMA sandbox image is already cached;
- the participant has one valid supported model-provider credential;
- `open-managed-agents` need not be installed globally;
- use a fresh `OMA_HOME` for the clean-state lane and record separate reuse runs.

Task:

```bash
npx --yes open-managed-agents@latest
```

The participant may follow the visible terminal prompts, including provider
selection and masked credential entry. They must not need `git clone`, `npm
link`, exported credential environment variables, a manually pasted workspace
key, agent YAML, or a second undocumented command.

Success:

- readiness checks pass before OMA stores a newly entered credential;
- the appliance starts or a healthy onboarding-owned appliance is reused;
- exactly one OMA-owned starter agent, environment, and session are selected;
- the browser opens through the single-use loopback bootstrap flow;
- the console is authenticated and displays the selected starter session ready
  for the first prompt;
- no raw provider, workspace, or admin credential appears in terminal output,
  URLs, browser storage, process arguments, logs, or the resume record;
- elapsed time from command submission to the ready session is at most 180
  seconds;
- no undocumented command or maintainer intervention is required.

## Diagnostic Scenario -- Cold Image

Run the same command without the pinned sandbox image cached. This lane is
required for product feedback but is not included in the three-minute gate.

Record separately:

- time to detect the missing image;
- whether the prompt explains the cold-start cost before state mutation;
- whether interactive approval or explicit `--pull` behaves as documented;
- image acquisition time and total onboarding time;
- recovery behavior after interruption or pull failure.

Non-interactive execution must not pull implicitly.

## Diagnostic Scenario -- Source Checkout

Use this lane to verify contributor and recovery documentation, not to measure
the public SLO:

```bash
git clone https://github.com/oneryalcin/open-managed-agents.git
cd open-managed-agents
npm ci
npm link
oma doctor
oma smoke --local-compatible
```

`oma doctor` must explain readiness issues without creating durable OMA state,
credential files, databases, locks, or Docker resources.

## Observation Rules

- Warm-path time starts when the participant submits the `npx` command.
- Warm-path time stops when the selected starter session is visible and ready.
- Use the actual public npm package and record the resolved immutable version.
- Count a gated run as failed if it exceeds 180 seconds, needs an undocumented
  command, exposes a secret, duplicates starter resources, or needs maintainer
  intervention.
- Record blockers exactly and link implementation follow-ups instead of
  rewriting failures as successful observations.
- Record browser-launch failure as a product failure unless the printed fallback
  URL is safe, clear, and sufficient for the participant to continue.
- Record provider rejection on the first real prompt separately from time-to-ready;
  the console must make the failure understandable without leaking credentials.

## Results

Status: not run yet.

### Public warm path

| Date | Participant | OS / arch | Node | Docker runtime | Package | State | Time | Result | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | _fresh/reuse_ | _pending_ | _pending_ | _pending_ |

### Diagnostic lanes

| Date | Scenario | OS / arch | Package | Detection / pull / total | Result | Follow-up |
| --- | --- | --- | --- | --- | --- | --- |
| _pending_ | _cold image/source checkout_ | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |

## Exit Gate

The public onboarding gate passes when:

- at least three non-maintainer public warm-path runs succeed;
- every successful gated run completes in 180 seconds or less;
- every successful gated run has zero undocumented intervention;
- the packed/public-package browser automation is green;
- every failed run has a linked follow-up or documented out-of-scope reason;
- cold-image behavior is measured and reported separately;
- the README's preview caveat is removed only after these results are recorded.
