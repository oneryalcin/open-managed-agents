# Alpha Onboarding Observation Protocol

This file records the human onboarding gate for the source-checkout alpha. It
is a protocol and results template until real observations are run. Do not fill
the results table with simulated data.

## Goal

Validate that a new user can get OMA running from the documented
[Getting Started](../getting-started.md) flow without undocumented
intervention.

## Participants

Use a small group before broad alpha invitation:

- at least 3 local-compatible participants;
- at least 3 credential-supplied console participants;
- participants should not be core maintainers of OMA.

## Scenario A -- Local-Compatible Proof

Target: median time at or below 10 minutes.

Starting state:

- fresh clone or fresh checkout;
- Node.js 22.19 or newer available;
- Docker or OrbStack available;
- no model provider credential required.

Task:

```bash
npm ci
npm link
oma doctor
oma smoke --local-compatible
```

Success:

- `oma doctor` explains any local readiness issue without mutating durable OMA
  state;
- `oma smoke --local-compatible` passes;
- the participant did not need undocumented commands or maintainer help.

## Scenario B -- Credential-Supplied Console Flow

Target: median time at or below 15 minutes.

Starting state:

- Scenario A prerequisites;
- one valid model credential supplied by the participant or test coordinator.

Task:

```bash
export ANTHROPIC_API_KEY="..."
oma up
```

Then in the browser:

1. log in with the workspace API key printed by `oma up`;
2. open Start;
3. confirm model credential readiness;
4. create an agent;
5. create an environment;
6. create a session;
7. send a prompt;
8. inspect the transcript/tool events;
9. interrupt if the session keeps running unexpectedly.

Success:

- the participant reaches a completed or understandable session state;
- the console shows real readiness/error state, not demo fallback data;
- no undocumented commands or maintainer intervention are needed.

## Observation Rules

- Time starts when the participant begins at the checkout.
- Time stops when the scenario success condition is met.
- Count a run as failed if the participant needs an undocumented command,
  hidden environment variable, maintainer intervention, or repo-local knowledge
  not present in [Getting Started](../getting-started.md).
- Record blockers exactly. Do not translate them into implementation tasks in
  this file; link follow-up issues instead.
- Do not record API keys, screenshots containing keys, hosted account IDs, or
  durable workspace IDs.

## Results

Status: not run yet.

| Date | Scenario | Participant | Time | Result | Follow-up |
| --- | --- | --- | --- | --- | --- |
| _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |

## Exit Gate

The human onboarding gate passes when:

- Scenario A median time is at or below 10 minutes;
- Scenario B median time is at or below 15 minutes;
- every completed successful run has zero undocumented intervention;
- every failed run has a linked follow-up or a documented out-of-scope reason.
