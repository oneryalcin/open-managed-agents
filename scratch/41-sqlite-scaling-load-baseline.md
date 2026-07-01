# Probe 41: SQLite Scaling Load Baseline

Date: 2026-07-01

Issue: #107

Harness: [`scratch/41-sqlite-scaling-load.ts`](41-sqlite-scaling-load.ts)

Purpose: establish a first file-backed SQLite baseline for the single-node
durable tier before changing store code. The workload excludes model calls and
sandbox compute; it targets the synchronous store pressure points directly:

- session creation;
- owner-fenced runtime turn acceptance;
- synchronized turn-completion bursts with runtime transcript rows;
- optional `SessionEventBroadcaster.publishPersisted` fan-out to live
  subscribers;
- session-list pagination through `SqliteSessionStore.deserialize`;
- optional per-session resources to exercise the known #52 N+1 path.

## Runs

All runs used the deployment file-backed stores created by
`createDeploymentStoresFromEnv`, with SQLite in WAL mode.

| Run | Sessions | Bursts | Events / turn | Resources / session | Subscribers / session | Events committed | Burst wall ms | Commit p99 ms | Publish p99 ms | Queue lag p99 ms | List total ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `probe41_1782917821099_3z2iu5` | 200 | 1 | 50 | 0 | 0 | 10,000 | 120.404 | 3.774 | n/a | 118.694 | 1.403 |
| `probe41_1782917832828_l3pf2d` | 400 | 1 | 50 | 0 | 0 | 20,000 | 236.812 | 4.435 | n/a | 234.667 | 2.608 |
| `probe41_1782917917663_hvj9v2` | 400 | 1 | 10 | 3 | 0 | 4,000 | 85.723 | 2.048 | n/a | 85.010 | 5.038 |
| `probe41_1782917930039_epazwe` | 400 | 1 | 50 | 3 | 0 | 20,000 | 229.936 | 4.222 | n/a | 227.696 | 5.333 |
| `probe41_1782918420457_wr2itv` | 400 | 1 | 50 | 0 | 1 | 20,000 | 238.944 | 4.388 | 0.043 | 236.732 | 2.431 |
| `probe41_1782918431941_4edm4p` | 400 | 10 | 50 | 0 | 0 | 200,000 | 223.702-272.239 | 3.630-7.416 | 0.014-0.024 | 221.525-269.883 | 2.411 |
| `probe41_1782918448941_zi1eyz` | 400 | 3 | 50 | 0 | 1 | 60,000 | 235.978-250.634 | 3.716-5.256 | 0.024-0.043 | 233.740-248.274 | 2.417 |

Raw artifacts are under
[`scratch/artifacts/sqlite-scaling-load`](artifacts/sqlite-scaling-load).

## Readout

The 200-400 session single-burst target is not showing a SQLite write bottleneck
in this direct-store harness. Commit p99 stayed under 5 ms for the 20,000-event
bursts, with total burst wall time scaling roughly linearly with the number of
scheduled sessions.

Queue lag is expected here: the harness deliberately schedules all sessions in
one `setImmediate` burst and each commit is synchronous, so later tasks wait
behind earlier SQLite work on the same event loop. It is the head-of-line signal
to watch as the workload becomes more realistic.

Broadcaster fan-out is not dominant in this in-process measurement. With 400
live subscribers, `publishPersisted` p99 stayed below 0.05 ms for each
50-event/session batch, and subscribers drained the expected event count. This
does **not** prove HTTP/SSE response streaming is cheap; it only clears the
in-memory broadcaster push path.

Sustained bursts show the first real tail signal. Over 10 consecutive
400-session / 20,000-event bursts, commit p99 rose from 3.630 ms to a 7.416 ms
high and one individual commit reached 20.538 ms. WAL size stayed around 4.2 MB
while the main DB grew to 117.9 MB, consistent with WAL+NORMAL checkpointing
keeping the WAL bounded on this local disk.

The #52-sensitive list path is visible but not yet dominant at this scale. With
400 sessions, adding three resources per session raised total list pagination
from 2.608 ms to 5.333 ms. That confirms the harness can expose the deserialize
resource path, but this baseline does not yet justify optimizing #52 ahead of
the broader #107 workload.

## Limits

- This is not an end-to-end runtime benchmark.
- It does not include model latency, sandbox startup, sandbox exec, SSE clients,
  HTTP routing, or filesystem materialization.
- It currently measures one-process SQLite behavior only.
- `publishPersisted` fan-out is measured, but HTTP SSE framing and client socket
  backpressure are not.
- For single short bursts, the event-loop delay monitor can complete before it
  has a useful sampling window; queue lag is the more useful head-of-line metric
  for those runs. Sustained bursts produce useful event-loop delay samples.

## Next Work

Use this harness as the baseline for #107, then add the missing end-to-end
pressure surfaces before optimizing:

- HTTP SSE fan-out / stream response clients;
- request handling around session create and message submit;
- repeated bursts over a longer window;
- larger resource counts if #52 remains a suspected bottleneck;
- memory and database-size tracking across longer runs.
