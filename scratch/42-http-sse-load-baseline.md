# Probe 42: HTTP/SSE Streaming Load Baseline

Date: 2026-07-01

Issue: #107

Harness: [`scratch/42-http-sse-load.ts`](42-http-sse-load.ts)

Purpose: measure the HTTP/SSE layer after Probe 41 cleared the direct SQLite
commit path and in-memory broadcaster fan-out. This harness forks a dedicated
server process running a real `@hono/node-server` listener, then drives it from
a separate client process with real `fetch` clients against the event stream
API. Fast clients parse SSE frames and count delivered events. Stalled clients
open SSE responses and deliberately do not read the response body until cleanup.

The app is wired with file-backed deployment stores but no runtime runner, so
`POST /events` persists `user.message` rows and publishes them without model or
sandbox work.

## Runs

All runs used the same SQLite WAL/NORMAL deployment pragmas as Probe 41.

| Run | Topology | Sessions | Fast clients | Stalled clients | Events / request | Events sent | Fast delivered | Burst wall ms | Request p99 ms | Queue lag p99 ms | Server RSS ready -> after drain |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `probe42_1782919977033_lubewq` | separate processes | 400 | 400 | 0 | 5 | 2,000 | 2,000 / 2,000 | 236.792 | 176.658 | 58.952 | 259.9 MB -> 323.6 MB |
| `probe42_1782919992465_bf5rwa` | separate processes | 400 | 400 | 1 | 5 | 2,000 | 2,000 / 2,000 | 206.389 | 157.460 | 47.635 | 258.8 MB -> 322.8 MB |
| `probe42_1782920007393_prddpx` | separate processes | 400 | 400 | 20 | 20 | 8,000 | 8,000 / 8,000 | 341.522 | 282.343 | 57.198 | 259.6 MB -> 367.5 MB |
| `probe42_1782920031870_q4l92a` | separate processes | 1 | 0 | 1 | 200 | 10,000 | n/a | 2.874-12.219 | n/a | n/a | 285.8 MB -> 310.4 MB |
| `probe42_1782922363198_wpwpem` | separate processes | 20 | 0 | 20 | 200 | 200,000 | n/a | 51.801-101.973 | n/a | n/a | 286.2 MB -> 442.8 MB |

Raw artifacts are under
[`scratch/artifacts/http-sse-load`](artifacts/http-sse-load).

## Readout

The harness originally ran server and clients in one Node process; those
same-process numbers were confounded by client-side fetch/read work sharing the
server event loop and are intentionally not recorded here. The current artifacts
use separate server and driver processes (`shared_event_loop: false`).

HTTP/SSE is still materially more expensive than the direct-store and
in-memory-broadcaster probes, but the corrected out-of-process p99 is lower than
the same-process artifact suggested. With 400 live HTTP SSE clients and 400
concurrent `POST /events` requests, request p99 was 157-177 ms for 2,000 events
and 282 ms for the heavier 8,000-event / 20-stalled-stream run. This includes
HTTP routing, response serialization, SSE framing, kernel loopback, and client
round-trip timing; it is not a pure server CPU metric.

Fast-client delivery held in every run: all expected SSE frames reached the fast
readers, including the run with 20 deliberately stalled readers. In these short
bursts, stalled readers did not create visible head-of-line blocking for fast
readers.

Server memory is now the metric to watch. Opening 400 fast streams raised
server RSS by roughly 64 MB during the 2,000-event burst. The heavier 20-stalled
reader run raised server RSS by roughly 108 MB. The targeted stalled-only probe
queued 10,000 events into one unread stream and raised server RSS by roughly
25 MB, with server array buffers up roughly 2.4 MB. This is not proof of an
unbounded leak, but it identifies connection and buffering pressure as the next
capacity ceiling to test, not SQLite commit time.

The broadcaster's own live queue is bounded (`DEFAULT_MAX_BUFFER = 10_000` and
overflow drops the queue before refetching from the store). That bound does not
fully define the HTTP memory envelope, because the `/events/stream` route
actively drains the broadcaster iterator and calls `ReadableStream.enqueue(...)`
for each SSE frame without checking downstream backpressure. In the aggregate
stalled-reader probe, 20 unread streams each received 10,000 frames; server RSS
rose by roughly 157 MB and server array buffers by roughly 41 MB. The result is
still bounded for this short run, but the capacity question has moved from
SQLite and broadcaster dispatch to HTTP response-stream/socket buffering.

## Limits

- The stalled clients do not read at all, but the bursts are still short enough
  that OS / undici / Web Stream buffering may absorb the data without forcing
  sustained socket backpressure.
- This does not include Pi runtime, model calls, sandbox execution, file
  materialization, or real remote clients.
- The harness still uses laptop-local loopback and local storage.
- Server RSS is measured without the client driver in-process, but without
  explicit post-GC normalization.

## Next Work

The next #107 slice should turn this into a longer-running HTTP/SSE endurance
test before optimizing:

- repeated bursts over minutes, not one short burst;
- periodic memory samples and post-GC measurements if Node is launched with
  `--expose-gc`;
- slower-but-reading clients in addition to fully stalled clients;
- larger event payloads to stress SSE frame serialization and socket buffers;
- a source fix or bounded policy for HTTP stream backpressure if endurance runs
  show response-buffer growth does not plateau;
- representative storage / deployment host rerun before any production capacity
  claim.
