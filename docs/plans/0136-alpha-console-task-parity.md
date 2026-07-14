# Plan 0136 -- Alpha console task parity

Status: implemented and independently reviewed; interactive browser verification pending

Date: 2026-07-14

## Goal

Turn the existing bundled console from a strong read-only inspector into one
complete alpha workflow:

```text
authenticate -> verify readiness -> create agent -> create environment
  -> create session -> send prompt -> watch events -> inspect tools/files
```

Task parity, not pixel parity, is the target. CMA screenshots are private
reference evidence under the gitignored `ui/CMA_screenshots/` directory.

## Evidence

### CMA reference observations

- `15.26.45` through `15.28.13`: a four-step Quickstart combines agent
  creation, environment configuration, a test session, generated API examples,
  readiness errors, and credential creation.
- `15.28.28`, `15.28.41`, `15.30.34`: agent list/detail/create surfaces expose
  status, model, immutable version, prompt, tools/MCP, filters, and create/test
  actions.
- `15.29.03` through `15.29.35`, plus `15.30.12`: sessions expose list/create,
  transcript/debug views, event search/filtering, rendered/raw event detail,
  tool calls/results, files/resources, and prompt actions.
- `15.29.51` through `15.30.04`: environments expose list/detail/create plus
  network-policy and package configuration.
- `15.30.24` through `15.31.21`: vaults expose list/detail/credential creation,
  MCP OAuth, bearer, and environment-variable credential forms with explicit
  shared-secret warnings.

The full filenames are timestamped `Screenshot 2026-07-14 at <time>.png` under
the private reference directory.

### OMA console observations

- Authentication, admin workspace/key management, workspace switching, and
  credential-in-memory boundaries are real API flows (`auth.jsx`; `api.js`).
- Agents, sessions, environments, files, vaults, credentials, and events are
  loaded from the real API (`api.js:240-281`).
- Session detail already renders transcript/debug/spans/files, event search,
  raw payloads, tool confirmation cards, failure banners, and loading/empty/error
  states (`detail.jsx:130-519`).
- Live API mode intentionally disables every general `/v1` write
  (`api.js:68-81`; `app.jsx:253-290`; `ui.jsx:130-146`).
- Agent/session forms and prompt/interrupt/confirmation controls currently
  mutate demo state only (`forms.jsx`; `detail.jsx`).
- Environments appear as a disabled sidebar entry, despite being required to
  create a session (`ui.jsx:99-104`).

## Task-parity matrix

| User job | CMA evidence | OMA today | Alpha disposition |
| --- | --- | --- | --- |
| Authenticate/select workspace | Quickstart workspace context | Real workspace/admin login and key management | **Keep; harden readiness copy** |
| Understand readiness | Quickstart step rail and network-policy errors | Errors exist, but no joined model/sandbox/environment readiness view | **Must add** |
| Create agent | Quickstart and create modal | Polished demo-only form; backend exists | **Must wire** |
| Inspect/version agent | Agent detail/version selector | Real read-only detail; immutable versions exist | **Keep; edit/update post-alpha** |
| Create/select environment | Quickstart and environment create/detail | Loaded for session form; nav is disabled; no mutation | **Must wire minimal safe create/list** |
| Create session | Session modal | Polished demo-only form; backend exists | **Must wire** |
| Send prompt | Ask Claude/composer | Visual control only; event API exists | **Must wire** |
| Interrupt running session | Session action | Visual/demo-only control; event API exists | **Must wire** |
| Watch live transcript | Transcript timeline | Real history hydration, no live SSE consumption | **Must add authenticated SSE** |
| Inspect tools/errors/raw events | Rendered/raw/debug views | Strong existing inspector | **Keep and connect to live stream** |
| Resolve tool confirmation | Requires-action flow | Demo-only card; backend exists | **Must wire** |
| Inspect/download files | Session files/output | Real list/download support | **Keep** |
| Create vault/credential | Vault and credential forms | Real browse/validate, no creation UI | **Should follow core happy path** |
| Deployments/observability/memory | Dedicated CMA screens | Backend capabilities deferred or incomplete | **Defer; do not add façade screens** |

## Product decisions

1. Do not reproduce CMA's conversational Quickstart generator for alpha. Use a
   compact readiness/start checklist and direct forms.
2. Environment creation is an alpha must-have even though the earlier worklist
   named only agent/session mutations: a fresh workspace cannot create a valid
   session without an environment.
3. Session creation and the first prompt remain two API operations. If session
   creation succeeds and the prompt fails, keep and open the session, explain
   the partial success, and allow retry; never pretend the transaction rolled
   back.
4. Keep `/v1` mutation access deny-by-default. Add narrow API functions and
   capability checks for each shipped console action; do not remove the generic
   write guard.
5. Readiness uses only public, observable contracts: authenticated workspace
   access plus the presence of agents and environments. OMA has no public model
   catalog, credential-validity, or active sandbox-provider readiness endpoint.
   Do not invent one in this UI slice or label those states healthy; surface
   their exact server errors during agent/session actions. A richer operational
   readiness endpoint is a separate backend decision.
6. Session creation and event submission use a generated `Idempotency-Key`.
   Retain the same key when retrying the same logical request and generate a new
   key when its payload changes. Agent and environment creation do not currently
   have a server idempotency contract: prevent duplicate submission, never
   auto-retry an ambiguous failure, and tell the user to refresh before retrying.
7. Use the authenticated SSE endpoint for live events. Because workspace auth
   is header-based, use `fetch` streaming with `x-api-key`, beta headers, and
   `Last-Event-ID`; do not place credentials in an EventSource URL.
8. Demo mode remains clearly labeled and local-only. Live API mode must never
   fall back to simulated mutation success.

## Implementation slices

### Slice 1 -- mutation boundary and readiness

- Add narrowly named/tested API methods for agent, environment, and session
  creation and session event submission.
- Add a Start/readiness state covering workspace auth and whether at least one
  agent/environment exists. Do not claim proactive model, credential, or
  sandbox-provider health without a public contract.
- Make Environments a real navigation destination with list/empty/create views.
- Preserve admin/workspace key separation and clear credentials on 401.

### Slice 2 -- create agent and environment

- Wire the existing agent form to `POST /v1/agents` using only currently
  supported model/tool values; surface server validation verbatim.
- Add a minimal environment form. Prefer a safe, explicit Docker-local alpha
  preset over exposing every environment field immediately.
- Disable duplicate submits, retain field input on error, and navigate to the
  real created resource on success.
- Do not automatically retry agent/environment creation after an ambiguous
  network failure; refresh the relevant list before offering a manual retry.

### Slice 3 -- create session and prompt

- Wire session creation to `POST /v1/sessions`.
- Remove any implication that `first_message` is part of that request. When the
  optional first-message field is used, submit `user.message` only after the
  session exists.
- Represent partial success explicitly and make prompt retry safe.
- Wire the idle-session composer to `user.message` and running-session interrupt
  to `user.interrupt`.
- Generate and retain idempotency keys for each session-create or event-submit
  intent so an ambiguous response can be retried without duplicating work.

### Slice 4 -- live timeline and confirmations

- Add an authenticated, cancellable SSE client with replay via
  `Last-Event-ID`, bounded reconnect/backoff, deduplication by event ID, and
  teardown on route/session/auth change.
- Merge streamed events through the existing `toUiEvent` mapping.
- Keep transcript/debug/raw/tool/file views; add reconnecting and stream-failed
  states without erasing persisted history.
- Wire allow/deny to `user.tool_confirmation` and refresh from persisted events
  rather than synthesizing follow-up rows.

### Slice 5 -- alpha verification

- Contract tests for every new API method, auth header, beta header, payload,
  idempotency key generation/reuse, and payload-change key rotation.
- Component/state tests for submit-in-flight, server validation, 401 re-login,
  partial session/prompt success, duplicate-event replay, reconnect, interrupt,
  and tool confirmation.
- One real-browser happy path against a temporary Docker-local appliance:
  login → create agent → create environment → create session → send bash-backed
  prompt → observe tool use/result and assistant message → interrupt a second
  run → inspect/download output where produced.
- Keyboard/focus/accessible-name pass for all new controls and dialogs.

## Deferred

- CMA-style conversational agent generation and template marketplace.
- Agent editing/version browsing UI beyond current read-only version display.
- Deployment scheduling, memory stores, analytics, and rich observability.
- Pixel matching, mobile-first layout, and full credential-registry breadth.
- Token-by-token text previews; persisted `agent.message` remains the alpha
  baseline unless event-honesty work adds a supported delta contract.

## Acceptance criteria

- A fresh authenticated workspace can complete the whole alpha workflow from
  the console without curl or SQLite access.
- No live action mutates only local React state or claims success before the API
  accepts it.
- A session remains understandable through running, idle, failed, interrupted,
  reconnecting, and requires-action states.
- Tool input/result/error and raw events are inspectable; produced files are
  downloadable.
- Credentials never enter URLs, storage, logs, or the wrong API tier.
- Retrying an ambiguous session-create or event-submit response with the same
  intent cannot create duplicate durable work.
- Unsupported CMA surfaces remain absent or explicitly deferred.
