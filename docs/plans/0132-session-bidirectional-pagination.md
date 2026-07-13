# Plan 0132 — Session bidirectional pagination

Status: complete

## Evidence

Hosted probe 66 establishes that `GET /v1/sessions` returns exactly
`{data,next_page,prev_page}`. Both cursors are submitted through `page`.
Traversal preserves the requested `asc`/`desc` order. The first page has a null
`prev_page`; the terminal page has a null `next_page`. Malformed cursors return
`400 invalid_request_error` (`invalid page cursor`), and a cursor reused with a
different order returns `page token order does not match request`.

This is session-specific. Agents, environments, and vaults expose
`{data,next_page}`; skills expose `{data,has_more,next_page}`; files use
`{data,first_id,last_id,has_more}` with `after_id`/`before_id`. This plan must not
change those resources or session-event pagination.

## Contract and design

- Replace the session list envelope's `has_more` field with `prev_page`.
- Use an opaque, versioned base64url cursor containing the anchor session ID,
  traversal direction, order, and normalized session-list filters. Authenticate
  the payload with a workspace-bound HMAC so clients cannot rewrite that
  context and re-encode a valid cursor.
- Reject malformed cursors and cursors whose order or filters do not match the
  request.
- For forward traversal, seek after the previous page's final row.
- For backward traversal, seek before the current page's first row, query in the
  inverse SQL order, then reverse the selected rows so the public order remains
  unchanged.
- Return `prev_page: null` on the initial boundary and `next_page: null` on the
  terminal boundary.
- Preserve workspace isolation and existing limit validation.

Cursor contents are implementation details, not a client API or authorization
mechanism. Workspace identity remains server context and is not trusted from the
cursor. The signing key is random and stable for one `SqliteSessionStore`
instance; outstanding cursors intentionally become invalid if that store is
recreated, including after deployment restart.

## Tests before implementation

1. API contract tests assert exact session envelope keys and no `has_more`.
2. Ascending and descending tests traverse page 1 → page 2 → page 1.
3. Terminal pages retain a backward cursor.
4. Malformed cursors return the hosted error.
5. Reuse under a different order or filter returns a mismatch error.
6. Store/service tests cover forward and backward boundaries.
7. Existing tests prove non-session list envelopes remain unchanged.

## Verification gates

- Focused session store/service and API tests.
- Full test suite.
- Typecheck and `git diff --check`.
- Update PARITY only after all gates pass.
