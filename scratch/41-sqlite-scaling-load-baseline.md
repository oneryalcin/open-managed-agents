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
- session-list pagination through `SqliteSessionStore.deserialize`;
- optional per-session resources to exercise the known #52 N+1 path.

## Runs

All runs used the deployment file-backed stores created by
`createDeploymentStoresFromEnv`, with SQLite in WAL mode.

| Run | Sessions | Events / turn | Resources / session | Events committed | Burst wall ms | Commit p99 ms | Queue lag p99 ms | List total ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `probe41_1782917821099_3z2iu5` | 200 | 50 | 0 | 10,000 | 120.404 | 3.774 | 118.694 | 1.403 |
| `probe41_1782917832828_l3pf2d` | 400 | 50 | 0 | 20,000 | 236.812 | 4.435 | 234.667 | 2.608 |
| `probe41_1782917917663_hvj9v2` | 400 | 10 | 3 | 4,000 | 85.723 | 2.048 | 85.010 | 5.038 |
| `probe41_1782917930039_epazwe` | 400 | 50 | 3 | 20,000 | 229.936 | 4.222 | 227.696 | 5.333 |

Raw artifacts are under
[`scratch/artifacts/sqlite-scaling-load`](artifacts/sqlite-scaling-load).

## Readout

The 200-400 session burst target is not showing a SQLite write bottleneck in
this direct-store harness. Commit p99 stayed under 5 ms for the 20,000-event
bursts, with total burst wall time scaling roughly linearly with the number of
scheduled sessions.

Queue lag is expected here: the harness deliberately schedules all sessions in
one `setImmediate` burst and each commit is synchronous, so later tasks wait
behind earlier SQLite work on the same event loop. It is the head-of-line signal
to watch as the workload becomes more realistic.

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
- The harness reports event-loop delay, but these short bursts can complete
  before the monitor has a useful sampling window; queue lag is the more useful
  head-of-line metric for this probe.

## Next Work

Use this harness as the baseline for #107, then add the missing end-to-end
pressure surfaces before optimizing:

- SSE fan-out / stream subscribers;
- request handling around session create and message submit;
- repeated bursts over a longer window;
- larger resource counts if #52 remains a suspected bottleneck;
- memory and database-size tracking across longer runs.
