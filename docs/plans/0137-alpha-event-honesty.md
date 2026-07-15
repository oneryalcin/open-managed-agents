# Plan 0137 -- Alpha event honesty

Status: complete; implemented, independently reviewed, and verified

Date: 2026-07-15

## Goal

Make OMA's shipped event contract describe only behavior clients can actually
observe before alpha users build against it.

## Decisions

1. OMA does not support CMA token-preview deltas yet. Any supplied
   `event_deltas[]` query parameter returns `400 invalid_request_error` before
   stream admission or subscription allocation.
2. `agent.thinking` is removed from the shipped `EVENT_TYPES` union, OpenAPI,
   and console filters. It remains a known deferred CMA event, not a reserved
   implemented type.
3. `system.message` is explicitly deferred pending a compatible session-update
   contract. OMA does not accept, emit, or advertise it.
4. Assistant text is persisted and streamed as one buffered `agent.message`
   after generation. Token-preview streaming is a separate future feature.

## Verification

- Route regression for valued and empty `event_deltas[]` parameters.
- Proof rejection occurs before a broadcaster subscription opens.
- Event-union alignment and OpenAPI regressions.
- Typecheck, focused event/OpenAPI tests, full suite, and `git diff --check`.

## Non-goals

- Implementing `event_start` / `event_delta` previews.
- Translating Pi thinking deltas.
- Adding mid-session system-prompt mutation.
