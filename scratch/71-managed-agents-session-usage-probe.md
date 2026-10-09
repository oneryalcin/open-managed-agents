# Probe 71 — hosted `session.usage` (0145 M2, usage metering)

Run with the CWC probe credential:

```bash
set -a; source /Users/oner/dev/junk/cwc-workshops/.env; set +a
uv run --with anthropic python scratch/71-managed-agents-session-usage-probe.py
```

One session on `claude-sonnet-5` with a ~16k-token system prompt (so prompt
caching engages). Turn 1: one `bash` call (`sleep 12`) then a reply (two model
requests); retrieve is polled every 0.5s. Turn 2: a one-line reply. Cleans up.

## Observed result (2026-10-09)

Artifact: [`artifacts/71-managed-agents-session-usage-probe.json`](artifacts/71-managed-agents-session-usage-probe.json)

- A new session's `usage` is **not null**: zeros, `cache_creation: null`,
  `active_seconds: 0`, `list_cost: {amount: "0", currency: "USD"}`,
  `server_tool_use: {web_fetch_requests: 0, web_search_requests: 0}`.
- **Token fields equal the sum of `span.model_request_end.model_usage`**
  exactly (turn 1: input 4, output 58, cache read 16600, cache write 16661).
  `cache_creation` splits the write into `ephemeral_5m_input_tokens` (all of it
  here) and `ephemeral_1h_input_tokens`.
- **Tokens and cost update only when the turn ends** (at idle), not per model
  request; during the running turn they stay at the previous value.
  `active_seconds` updates live while running and stops at idle.
- **Cumulative** across turns. `sessions.list` items carry the same `usage`.
- `list_cost.amount` is **integer minor units** (cents) as a string, priced at
  public list rates ("5" = $0.05 after turn 1, unchanged after a tiny turn 2).
  The API reference says it includes runtime priced on `active_seconds`, but
  model-only rates already give about 5 cents for turn 1, so the runtime part
  was not visible here.
- The API reference also documents `session.stats` (`active_seconds`,
  `duration_seconds`) and `session.budget` (`max_list_cost`), not in OMA yet.
