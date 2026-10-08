# Probe 70 — a second `user.message` while a turn runs (#245)

Run with the CWC probe credential:

```bash
set -a; source /Users/oner/dev/junk/cwc-workshops/.env; set +a
uv run --with anthropic python scratch/70-managed-agents-mid-turn-message-probe.py
```

Two scenarios against hosted Managed Agents (`claude-sonnet-5`): message A asks
for `bash` running `sleep 25` and then a reply; message B ("reply with exactly
B") is sent either while the bash tool runs (`during_tool`) or immediately
after A (`immediate`). Cleans up sessions, agent, and environment.

## Observed result (2026-10-08)

Artifact: [`scratch/artifacts/70-managed-agents-mid-turn-message-probe.json`](artifacts/70-managed-agents-mid-turn-message-probe.json)

- B is **accepted** (200, `processed_at: null` in the send response); hosted
  does not reject a mid-turn message.
- B is **steered into the running turn**: it lands after the in-flight
  `agent.tool_result` and before the next `span.model_request_start`. Its
  persisted `processed_at` is the delivery time, not the send time.
- **One** `session.status_running` and **one** `session.status_idle` per
  session; no second turn, no early idle, no `system.*` frames.
- The model answered B only; A's "then reply" was superseded by the steer.
- In `immediate`, retrieve still said `idle` when B was sent, yet B queued
  behind A identically, so hosted serializes per session, not by status.

## OMA comparison (real Pi 0.85.1, faux provider, no network)

Run as throwaway scripts on 2026-10-08; results recorded here.

- `PiSessionRunner` already queues a mid-turn message on the running Pi
  session (no parallel turn). #245's "idle while a turn runs" timeline came
  from a test fake (`GatedTurnRunner`) that runs every message as an
  independent turn; the production runner cannot produce it, and
  `session-runtime-continuity-api.test.ts` asserts a single idle.
- OMA used Pi `followUp()`: B was delivered only after A's turn would have
  ended (`toolResult, assistant reply, user:B, assistant reply`, one extra
  model request). Pi `steer()` gives the hosted shape exactly:
  `toolResult, user:B, assistant reply`, one `agent_end`.
- A message arriving at the `agent_end` boundary (OMA's `handle.running`
  already false, Pi still streaming) makes `prompt()` reject with "already
  processing"; both `steer()` and `followUp()` then run it as a second agent
  cycle inside the first `prompt()`, so it is not stranded.

OMA now steers (#245 fix). Remaining difference: OMA persists `user.message`
at send time, so it can appear before the in-flight tool result in the event
log, where hosted shows it at delivery.
