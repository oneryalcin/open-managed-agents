# Probe 42: HTTP/SSE Streaming Load Baseline

Date: 2026-07-01

Issue: #107

Harness: [`scratch/42-http-sse-load.ts`](42-http-sse-load.ts)

Purpose: measure the HTTP/SSE layer after Probe 41 cleared the direct SQLite
commit path and in-memory broadcaster fan-out. This harness runs a real
`@hono/node-server` listener and real `fetch` clients against the event stream
API. Fast clients parse SSE frames and count delivered events. Stalled clients
open SSE responses and deliberately do not read the response body until cleanup.

The app is wired with file-backed deployment stores but no runtime runner, so
`POST /events` persists `user.message` rows and publishes them without model or
sandbox work.

## Runs

All runs used the same SQLite WAL/NORMAL deployment pragmas as Probe 41.

| Run | Sessions | Fast clients | Stalled clients | Events / request | Events sent | Fast delivered | Burst wall ms | Request p99 ms | Queue lag p99 ms | RSS before -> after drain |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `probe42_1782919214548_g7irno` | 400 | 400 | 0 | 5 | 2,000 | 2,000 / 2,000 | 319.952 | 301.989 | 46.000 | 257.7 MB -> 414.9 MB |
| `probe42_1782919197065_2u3yxr` | 400 | 400 | 1 | 5 | 2,000 | 2,000 / 2,000 | 317.206 | 281.599 | 46.770 | 257.6 MB -> 406.2 MB |
| `probe42_1782919230512_1id8w6` | 400 | 400 | 20 | 20 | 8,000 | 8,000 / 8,000 | 443.070 | 396.539 | 50.992 | 254.7 MB -> 417.5 MB |

Raw artifacts are under
[`scratch/artifacts/http-sse-load`](artifacts/http-sse-load).

## Readout

The HTTP/SSE layer is materially more expensive than direct-store or
in-memory-broadcaster measurement. With 400 live HTTP SSE clients and 400
concurrent `POST /events` requests, request p99 was 282-302 ms for 2,000 events,
versus Probe 41's direct-store 20,000-event burst at roughly 4 ms commit p99.
That is expected: this path includes HTTP routing, response serialization,
client fetch overhead, SSE framing, and stream delivery.

Fast-client delivery held in every run: all expected SSE frames reached the fast
readers, including the run with 20 deliberately stalled readers. In these short
bursts, stalled readers did not create visible head-of-line blocking for fast
readers.

Memory is now the metric to watch. Opening 400 fast streams raised RSS by about
150 MB during the burst, and the heavier stalled-reader run increased external /
array-buffer memory compared with the lower-volume runs. This is not yet proof
of an unbounded leak, but it is the first signal that the HTTP/SSE capacity
ceiling is likely connection and buffering pressure, not SQLite commit time.

## Limits

- The stalled clients do not read at all, but the bursts are still short enough
  that OS / undici / Web Stream buffering may absorb the data without forcing
  sustained socket backpressure.
- This does not include Pi runtime, model calls, sandbox execution, file
  materialization, or real remote clients.
- The harness measures one Node process on laptop local storage.

## Next Work

The next #107 slice should turn this into a longer-running HTTP/SSE endurance
test before optimizing:

- repeated bursts over minutes, not one short burst;
- periodic memory samples and post-GC measurements if Node is launched with
  `--expose-gc`;
- slower-but-reading clients in addition to fully stalled clients;
- larger event payloads to stress SSE frame serialization and socket buffers;
- representative storage / deployment host rerun before any production capacity
  claim.
