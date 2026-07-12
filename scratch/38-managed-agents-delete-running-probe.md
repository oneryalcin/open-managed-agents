# Probe 38 — delete a running session

Run with the CWC probe credential:

```bash
set -a; source /Users/oner/dev/junk/cwc-workshops/.env; set +a
uv run --with anthropic python scratch/38-managed-agents-delete-running-probe.py
```

This probe captures the hosted status/type/message/body for `DELETE` while a
session is genuinely `running`, then repeats the operation with `DELETE` and
`user.interrupt` submitted concurrently. The result settles both the ordinary
error contract and which operation wins the race. It cleans up sessions,
agent, and environment in a `finally` block.

## Observed result (2026-07-12)

Artifact: [`scratch/artifacts/38-managed-agents-delete-running-probe.json`](artifacts/38-managed-agents-delete-running-probe.json)

- `DELETE` while `status=running` returns **400** with `type:
  invalid_request_error` and the exact message:
  `Cannot delete session while it is running. Send an interrupt event or wait for the session to complete.`
- The rejected delete does not interrupt the session; an immediate retrieve
  still reports `running`.
- In the concurrent race, `user.interrupt` is accepted with **200** while
  `DELETE` is rejected with the same 400. The interrupt is asynchronous, so an
  immediate retrieve can still report `running` before it settles.
- The probe cleanup interrupted any remaining work, deleted both sessions and
  the environment, and archived the agent.
