# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-07-14
- Primary product surfaces: bundled operator console at `/console/`, API docs at
  `/docs/`, and the local `oma` CLI.
- Evidence reviewed:
  - `ALPHA.md` and `PARITY.md`;
  - `ui/managed-agents-console/README.md` and all console source files;
  - private CMA reference captures under `ui/CMA_screenshots/` (gitignored);
  - the shipped `/v1` and `/admin` route contracts;
  - plan 0136's task-parity audit.

## Brand

- Personality: technical, calm, local-first, inspectable, and honest about
  capability boundaries.
- Trust signals: explicit workspace identity, visible runtime state, raw event
  access, concrete endpoint/error details, and no hidden credential persistence.
- Avoid: consumer-chat gloss, silent mock behavior, controls that imply an
  unsupported action, fake real-time state, and pixel imitation of CMA.

## Product goals

- Goals:
  - let an alpha user complete workspace → agent → environment → session →
    prompt without leaving the console;
  - make tool execution, failures, confirmations, and produced files easy to
    inspect;
  - keep CMA-compatible concepts and terminology where OMA ships them;
  - make OMA-specific operational and security behavior explicit.
- Non-goals:
  - full CMA console cloning;
  - conversational agent generation, deployments, memory, analytics, or rich
    observability before their backend capabilities exist;
  - pixel parity.
- Success signals:
  - a fresh workspace can reach a successful sandbox-backed session from the
    console;
  - every visible primary action either works against the real API or is absent;
  - users can diagnose a failed run from the UI without querying SQLite or
    tailing server logs.

## Personas and jobs

- Primary personas: self-hosting developer, early evaluator, and local appliance
  operator.
- User jobs:
  - authenticate or recover workspace access;
  - understand workspace, agent, environment, and credential readiness, while
    receiving honest action-time errors for model or sandbox unavailability;
  - create and inspect versioned agents;
  - create a session, send work, interrupt it, and resolve confirmations;
  - inspect transcript events, raw payloads, tool input/output, errors, and
    downloadable files.
- Key contexts of use: desktop browser on the same trusted machine or private
  network as the appliance; keyboard and mouse; intermittent model or sandbox
  failures are expected during alpha.

## Information architecture

- Primary navigation:
  - Start / readiness;
  - Agents;
  - Environments;
  - Sessions;
  - Files;
  - Vaults;
  - Administration when an admin key is active;
  - API documentation.
- Core routes/screens:
  - login and workspace selection;
  - readiness/start screen;
  - agent list, detail, and create;
  - environment list, detail, and create;
  - session list, create, and live detail;
  - files and vault/credential health;
  - admin workspace/key management.
- Content hierarchy: current state and blocking action first, primary task
  second, configuration detail third, raw/debug evidence always available but
  visually secondary.

## Design principles

1. **Truth before polish.** A disabled or absent control is preferable to a
   convincing local-only simulation on live data.
2. **One guided path, many inspection paths.** Optimize creation for the alpha
   happy path; preserve deep event and raw-data inspection for debugging.
3. **Security boundaries stay visible.** Workspace/admin keys, network policy,
   sandbox provider, tool confirmation, and credential readiness must not be
   collapsed into generic success/failure states.
- Tradeoffs: desktop operational density is preferred over mobile-first layout;
  CMA task terminology is preferred where contracts match, while OMA-specific
  limitations are stated directly.

## Visual language

- Color: retain the warm graphite surfaces and amber primary accent already
  defined in `console.css`; semantic green/red/idle and event-role colors carry
  meaning and must not be decorative-only.
- Typography: Geist/system sans for UI and Geist Mono/system monospace for IDs,
  endpoints, commands, and raw payloads.
- Spacing/layout rhythm: dense operator tables with 26px default gutters and a
  compact option; avoid large marketing-style whitespace.
- Shape/radius/elevation: existing 6/9/13px radius scale, restrained borders,
  and shallow elevation.
- Motion: short state transitions only; respect `prefers-reduced-motion`.
- Imagery/iconography: functional line icons and status marks; no decorative
  illustration requirement.

## Components

- Existing components to reuse: sidebar, `PageHead`, tables, pills/badges,
  fields/selects, modal/confirmation dialog, skeleton/empty/error states,
  session transcript/debug inspector, files panel, and mode/warning banners.
- New/changed components:
  - readiness/start checklist based only on public, observable state;
  - API-backed agent and environment forms;
  - API-backed session form with explicit two-step initial-message state;
  - authenticated SSE stream state and reconnect notice;
  - mutation error/success feedback and retry affordances.
- Variants and states: idle, running, needs action, archived, unavailable,
  loading, partial, empty, error, reconnecting, and mutation-in-flight.
- Token/component ownership: extend `console.css` variables and current plain
  React components; do not introduce a second design system or build step.

## Accessibility

- Target standard: WCAG 2.2 AA for the alpha happy path.
- Keyboard/focus behavior: all controls reachable and visibly focused; dialogs
  trap focus, close with Escape, and restore focus; tables and event rows expose
  actionable semantics rather than click-only `div`s.
- Contrast/readability: maintain AA contrast for body text, controls, errors,
  and focus indicators; status may not rely on color alone.
- Screen-reader semantics: announce running/idle/error/confirmation changes and
  mutation outcomes; label icon-only controls.
- Reduced motion and sensory considerations: preserve existing reduced-motion
  handling and avoid continuous animation except a nonessential live indicator.

## Responsive behavior

- Supported breakpoints/devices: desktop is the alpha target; 1024px-wide laptop
  is the minimum supported workspace.
- Layout adaptations: collapse the session inspector below the event list and
  allow sidebar collapse at narrower widths; preserve readable raw payloads.
- Touch/hover differences: important meaning and endpoint hints cannot exist
  only in hover tooltips.

## Interaction states

- Loading: skeletons for list/detail fetches; disable duplicate submissions.
- Empty: explain the next real action, especially agent/environment/session
  prerequisites.
- Error: show the server message, affected action, and a safe retry path; retain
  partially created resources when retrying a later step.
- Success: navigate to the created resource and show a short confirmation.
- Disabled: explain the unmet prerequisite or unsupported capability inline.
- Offline/slow network: distinguish API unreachable, SSE reconnecting, model
  working, and sandbox/runtime failure.

## Content voice

- Tone: direct, technical, and specific without assuming internal codebase
  knowledge.
- Terminology: use agent, environment, session, event, tool confirmation,
  workspace key, admin key, vault, and credential consistently.
- Microcopy rules: name the blocked resource or endpoint; never claim an action
  was sent until the API accepted it; distinguish created, running, idle,
  interrupted, and failed.

## Implementation constraints

- Framework/styling system: vendored React/ReactDOM with in-browser Babel and a
  single CSS file; no build step or CDN.
- Design-token constraints: extend existing CSS custom properties and component
  patterns.
- Performance constraints: bound automatic pagination; incrementally consume
  SSE; do not repeatedly reload full event history while a session runs.
- Compatibility constraints: credentials remain in page memory only; admin and
  workspace keys never cross API tiers; `/v1` writes are individually
  capability-gated rather than enabled through a generic transport switch;
  session creation and event submission use the backend's idempotency contract.
- Test/screenshot expectations: contract-test every mutation payload and header;
  test loading/error/partial-success states; capture the complete alpha happy
  path at desktop width before merge.

## Open questions

- [ ] Decide whether Start/readiness is a dedicated route or the empty state of
  Sessions; owner: console implementation slice; impact: onboarding clarity.
- [ ] Decide whether environment creation exposes only the safe Docker-local
  alpha preset or the complete API schema; owner: console implementation slice;
  impact: form scope and validation.
- [ ] Decide whether vault/credential creation joins the first alpha mutation
  slice or follows the core no-MCP happy path; owner: product; impact: MCP setup
  completeness.
