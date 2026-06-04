# 0097 - Managed Agents UI Parity

## Context

OMA now has enough of the Managed Agents control plane to justify a first
repo-local UI:

- agents can be created, listed, retrieved, and archived through
  `src/control-plane/agents/routes.ts`;
- sessions can be created, listed, retrieved, archived, and deleted through
  `src/control-plane/sessions/routes.ts`;
- session events can be listed, filtered by type, and streamed through
  `src/control-plane/events/routes.ts`;
- files can be uploaded, listed, retrieved, deleted, and downloaded through
  `src/control-plane/files/routes.ts`;
- model-request spans are present in `src/types/events.ts`;
- session output files are exposed through `GET /v1/files?scope_id=<session_id>`
  and `GET /v1/files/:id/content`;
- the CWC-style `examples/ship-your-first-managed-agent` path proves real
  Python SDK + Docker-local execution.

The Anthropic Console screenshots we have been using show the essential
operator surface:

- agents list/detail;
- sessions list/detail;
- transcript/debug tabs;
- event rows with tool/span timing;
- side-panel event detail;
- files/output downloads;
- a sidebar that keeps Managed Agents resources discoverable.

This plan is for OMA's first local Managed Agents UI. It is not a product
shell, auth system, billing console, or exact clone of Anthropic's hosted
Console. It should make the features OMA already has inspectable and useful.

## Goal

Build a small local UI that lets a developer inspect and operate the OMA MVP
without switching between curl, SDK scripts, and raw JSON.

The first UI slice should support:

- agents list and detail;
- sessions list and detail;
- session transcript view;
- debug/event view with event-type filtering;
- model span/tool rows with readable timing/usage summaries;
- session output file listing and download links;
- basic create-session and send-message flows;
- interrupt and delete/archive actions where the backend already supports them.

The UI should be good enough to demo the CWC-style local flow and to debug
sessions produced by SDK users.

## Non-Goals

- Do not implement production auth, RBAC, tenancy, billing, or org switching.
- Do not implement hosted-cloud environment management beyond showing existing
  OMA environment IDs.
- Do not fake memory stores, vaults, outcomes, skills, MCP, multiagent threads,
  or dreams.
- Do not implement a general low-code agent builder in the first slice.
- Do not mutate or repair event history from the UI.
- Do not make the UI a dependency of the core API package's runtime tests.
- Do not require logging into Anthropic's dashboard to start this slice.
  Dashboard login is useful later for exact interaction details, but the first
  cut can use screenshots, hosted probes, and API docs.

## Decision

Add a repo-local TypeScript SPA for the Managed Agents console, separate from
the control-plane package but committed in the same repository.

Recommended shape:

```text
ui/managed-agents-console/
  package.json
  index.html
  src/
    api/
    components/
    features/
    routes/
    styles/
```

Use Vite + React + TypeScript for the first UI app.

Reasons:

- The repo has no current frontend surface, so adding a separate app avoids
  polluting `src/control-plane/*` with UI concerns.
- React/Vite gives a familiar browser development loop, routeable views, and
  testable components without inventing a UI runtime.
- A separate `ui/` app can proxy to a local OMA server during development and
  later be served as static assets by an optional Hono route.
- The control-plane REST/SSE API remains the source of truth. The UI should
  never call stores or internal services directly.

## Alternatives Considered

### A. Vite + React SPA under `ui/managed-agents-console`

Pros:

- Good fit for a session transcript/debug UI.
- Clear boundary from API server code.
- Easy browser testing with Playwright or the in-app Browser.
- Can grow into a richer operational tool without changing API contracts.

Cons:

- Adds frontend dependencies and build scripts to a backend-heavy repo.
- Requires package-script discipline so UI work does not slow backend tests.

Decision: choose this for the first serious UI slice.

### B. Hono-rendered HTML with minimal client JavaScript

Pros:

- Very small dependency footprint.
- Can be served directly by the existing Node server.
- Good for static lists and simple forms.

Cons:

- Session transcript, event filters, SSE streaming, side panels, and future
  timeline interactions become harder to keep clean.
- More temptation to mix API-server and presentation concerns.

Decision: reject for this slice. It is too limiting for the UI we actually
need.

### C. Streamlit-only operational UI

Pros:

- We already have a Streamlit example.
- Fast for the CWC demo path.

Cons:

- It exercises the Python SDK, not OMA's own product UI surface.
- It does not help TypeScript/browser UI parity with the hosted Console.
- It cannot become a clean embedded local console for the Node control plane.

Decision: keep Streamlit as an example, not the OMA UI.

## Product Scope

### First Slice: Sessions-Centered Console

The first screen should be the actual operator experience, not a marketing
landing page.

Primary navigation:

- Agents
- Sessions
- Files

Secondary/deferred navigation can show disabled or absent items only if they are
not misleading. Prefer not showing unsupported hosted features yet.

### Agents

List view:

- agent ID;
- name;
- model ID and speed;
- version;
- archived status;
- created/updated timestamps;
- tool summary.

Detail view:

- model;
- system prompt;
- tool definitions;
- custom tool schemas;
- linked sessions filtered by `agent_id`.

Actions:

- archive agent;
- create session for this agent by selecting an environment ID manually or from
  the environment list if available.

### Sessions

List view:

- session ID;
- title;
- status;
- agent name/ID;
- environment ID;
- resource count;
- created/updated timestamps.

Detail view:

- header with status, agent, environment, duration/usage if available;
- transcript tab;
- debug/events tab;
- files/output tab;
- send-message composer;
- interrupt action while running;
- archive/delete actions.

### Transcript Tab

Render the user-facing conversation:

- `user.message`;
- `agent.message`;
- `agent.tool_use`;
- `agent.tool_result`;
- `agent.custom_tool_use`;
- `user.custom_tool_result`;
- `user.tool_confirmation`;
- `session.status_idle` with `requires_action`.

Tool rows should be compact and scannable by default, with detail expansion for
JSON input/result. Use event IDs as stable keys.

### Debug / Events Tab

Render the append-only log as an operational timeline:

- type filter using `GET /v1/sessions/:id/events?types[]=...`;
- search by event ID/type/text;
- event detail side panel with formatted JSON;
- clear visual distinction between transcript, tool, span, and session
  lifecycle events.

Do not hide raw event payloads from this tab. Debuggability is the point.

### Spans and Timing

For `span.model_request_start` / `span.model_request_end`:

- pair end events to their start by `model_request_start_id`;
- display duration from `processed_at` deltas;
- display `model_usage` token/cache fields;
- display `is_error` state;
- show unpaired starts as open/incomplete.

The UI should not invent provider/model metadata for spans. If the public event
does not carry it, leave it absent.

### Files / Outputs

For session detail:

- call `GET /v1/files?scope_id=<session_id>`;
- list generated output files with filename, size, MIME type, created time, and
  downloadability;
- provide download links using `GET /v1/files/:id/content`;
- make non-downloadable rows visibly non-clickable if future mounted input-copy
  rows become visible.

Workspace-level Files view:

- list uploaded workspace files;
- upload a file;
- show session-scoped output files only when a session filter is active.

## API Client Boundary

Create a typed UI API layer instead of scattering `fetch` calls through
components.

Recommended modules:

```text
src/api/client.ts
src/api/types.ts
src/api/events.ts
src/api/files.ts
src/api/sessions.ts
src/api/agents.ts
```

Rules:

- Every request sends `anthropic-beta: managed-agents-2026-04-01`.
- File routes also send the Files API beta if the backend requires it.
- API errors render the Anthropic-shaped error envelope with `request_id`.
- The API layer owns pagination cursors.
- Components receive typed data or typed loading/error states.
- The SSE client owns reconnect and de-duplication by event ID.

## Routing

Recommended initial routes:

```text
/agents
/agents/:agentId
/sessions
/sessions/:sessionId
/files
```

Default route should redirect to `/sessions`, because sessions are the most
useful operational starting point.

## Visual Direction

Use the hosted Console screenshots as information-architecture references, not
pixel-perfect targets.

Design principles:

- dense but calm operational UI;
- no marketing hero;
- no decorative card-heavy layout;
- compact tables and split panes;
- fixed-width event-type badges;
- stable row heights where possible;
- side panel for raw event detail;
- dark terminal-like JSON blocks only where they help inspect payloads;
- responsive enough for laptop and desktop first; mobile can be basic in v1.

The first implementation should use a restrained neutral palette with one
accent color, not a one-note dark-blue/purple gradient UI.

## Backend Integration

Initial development can run two processes:

```bash
npx tsx examples/ship-your-first-managed-agent/oma-server.ts
npm run ui:dev
```

The UI dev server should proxy `/v1/*` to the OMA server.

Follow-up option:

- add an optional `OMA_CONSOLE_ENABLED=true` route that serves built static UI
  assets from the control-plane server;
- keep this disabled by default until auth and deployment boundaries are clear.

Do not make the control-plane app depend on the UI build in normal tests.

## Testing Plan

### Unit / Component

- API client parses list/detail/error envelopes.
- Event grouping renders transcript vs debug rows correctly.
- Span pairing handles normal, error, and unpaired cases.
- File list renders downloadable vs non-downloadable rows.

### Integration

- Use mocked API responses for agents/sessions/events/files.
- Verify route transitions and side-panel behavior.
- Verify SSE de-duplication by event ID.
- Verify send-message and tool-confirmation forms emit the correct user events.

### End-to-End

Run local OMA with Docker-local and use Playwright or the in-app Browser to:

- open `/sessions`;
- create or select a session from the CWC example flow;
- send a prompt;
- observe transcript rows;
- switch to debug events;
- verify span rows render token usage;
- verify output files appear and download.

### Visual QA

Before merging UI implementation:

- capture desktop screenshots for sessions list and session detail;
- capture a narrow viewport screenshot to verify text does not overlap;
- inspect browser console for errors;
- verify loading, empty, and API-error states.

## Acceptance Criteria

- A developer can run the UI locally with documented commands.
- The UI talks only to public OMA HTTP/SSE endpoints, not stores or internal
  services.
- Agents list/detail and sessions list/detail render against live OMA.
- Session detail has transcript and debug/event views.
- Session detail can send a `user.message`.
- Running sessions can receive `user.interrupt`.
- `requires_action` rows for custom tools and tool confirmations are visible.
- Session outputs are listed and downloadable from session detail.
- Model-request spans are paired and display duration plus `model_usage`.
- SSE live updates de-duplicate against `events.list` replay.
- Empty/error/loading states are explicit and non-overlapping.
- The implementation includes browser-level verification screenshots.
- Backend unit tests remain independent of the UI build.

## Risks and Mitigations

### Risk: UI scope expands into unsupported hosted features

Mitigation: first slice shows only resources backed by OMA endpoints. Unsupported
hosted features remain absent or clearly deferred.

### Risk: UI bypasses the API and couples to stores

Mitigation: all data flows through `/v1/*` and the SSE stream. No imports from
`src/control-plane/*` in the UI app.

### Risk: frontend dependencies slow backend development

Mitigation: keep UI package scripts separate. `npm test` and `npm run
typecheck` for the backend should not require a UI build unless explicitly
requested.

### Risk: hosted Console exact behavior is guessed

Mitigation: use screenshots for information architecture only. When exact
interaction semantics matter, probe or log into hosted Console and record the
observation before coding.

### Risk: event timelines become misleading

Mitigation: debug tab always exposes raw event JSON. Derived durations and span
pairs are additive views, not replacements for the append-only log.

## Implementation Steps

1. Add `ui/managed-agents-console` with Vite, React, TypeScript, and a minimal
   test setup.
2. Add package scripts without disrupting existing backend scripts:
   - `ui:dev`
   - `ui:build`
   - `ui:test`
3. Implement the typed API client and shared UI event/file/session/agent types.
4. Implement shell navigation and routes.
5. Implement sessions list and session detail.
6. Implement event transcript/debug rendering and SSE live updates.
7. Implement agents list/detail.
8. Implement files/output listing and downloads.
9. Add create-session/send-message/interrupt/actions that use existing public
   endpoints.
10. Add browser verification and screenshots.
11. Update README/docs with local run commands.

## ADR

### Decision

Build OMA's first Managed Agents UI as a separate Vite + React + TypeScript SPA
under `ui/managed-agents-console`, consuming only public OMA HTTP/SSE APIs.

### Drivers

- Make the implemented backend observable and usable.
- Preserve the Managed Agents API as the contract boundary.
- Avoid coupling presentation code to control-plane stores/services.
- Keep the first UI slice focused on features OMA already supports.
- Leave room to serve the UI statically later without forcing that into v1.

### Alternatives Considered

- Hono-rendered HTML: lower dependency cost, but too limiting for transcript,
  SSE, filters, side panels, and timeline interactions.
- Streamlit-only UI: useful as an example, but not an OMA product/debug console.
- Exact hosted Console clone: too broad and likely to overfit private product
  details we have not verified.

### Why Chosen

The separate SPA gives the UI enough structure for a real operational console
while keeping the control plane clean. It also lets us build and test the UI as
an ordinary frontend app without changing the backend runtime boundary.

### Consequences

- The repo gains a frontend dependency set.
- UI build/test scripts must stay separate from backend verification.
- We need browser QA for UI PRs.
- The UI becomes another parity surface that needs issue tracking as backend
  features land.

### Follow-ups

- Decide whether and when to serve built UI assets from the Hono app.
- Add login/auth UI only after backend auth exists.
- Revisit hosted Console with real login when exact interaction behavior matters.
- Add UI tracker issue after the first implementation PR lands.
