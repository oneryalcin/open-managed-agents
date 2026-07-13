# Probe 66 — hosted pagination and backward cursors

Date: 2026-07-13
Status: complete
Artifact: `scratch/artifacts/66-managed-agents-pagination-probe.json`

## Method

The probe created one agent, one cloud environment, and five sessions. It listed
the sessions with `limit=2` in ascending and descending order, followed
`next_page`, then submitted page 2's `prev_page` through the ordinary `page`
parameter. It also tested malformed cursor handling and reuse under the opposite
sort order. All resources were deleted or archived afterward.

The script reads the hosted credential directly from
`/Users/oner/dev/junk/cwc-workshops/.env`. Durable IDs and opaque cursors are
replaced by stable pseudonyms. For other list resources, only envelope keys,
counts, booleans, and pseudonymized cursors are retained; resource content is
not written.

Run:

```bash
uv run --with anthropic python scratch/66-managed-agents-pagination-probe.py
```

## Session findings

- Session pages contain exactly `data`, `next_page`, and `prev_page`. They do
  **not** contain `has_more`.
- The first page has `prev_page: null`; the terminal page has
  `next_page: null`.
- Page 2's `prev_page`, supplied as `page`, returned the same records and cursor
  shape as page 1.
- Backward traversal preserves the requested public order. It does not return
  records reversed:
  - ascending page 1: sessions 1–2; page 2: 3–4; backward: 1–2;
  - descending page 1: sessions 5–4; page 2: 3–2; backward: 5–4.
- The one-record ascending terminal page still supplied a non-null `prev_page`.
- An invalid cursor returned HTTP 400 `invalid_request_error` with
  `invalid page cursor`.
- Reusing an ascending cursor with `order=desc` returned HTTP 400
  `invalid_request_error` with `page token order does not match request`.

## Cross-resource envelope findings

The current hosted SDK and observed envelopes do not expose one universal page
contract:

- `sessions`: `{data, next_page, prev_page}` — bidirectional cursor.
- `agents`: `{data, next_page}` — forward cursor only.
- `environments`: `{data, next_page}` — forward cursor only.
- `vaults`: `{data, next_page}` — forward cursor only.
- `skills`: `{data, has_more, next_page}` — forward cursor plus `has_more`.
- `files`: `{data, first_id, last_id, has_more}` and uses `after_id`/`before_id`
  request parameters rather than `page`.

Only sessions should receive the CMA `prev_page` contract. Other resources need
their own existing envelope semantics preserved rather than a cross-cutting
`prev_page` field.

## Remaining evidence boundary

This probe establishes ordinary forward/backward traversal, ordering, terminal
boundaries, and two cursor errors. It does not yet establish mutation behavior
when sessions are created, archived, or deleted between cursor requests, nor
whether changing filters other than `order` invalidates a cursor.
