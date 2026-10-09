# Changelog

## Unreleased

### Fixes

- **The model keeps the conversation across idle eviction and restarts**
  (#265, plan 0147). Each settled turn is saved with the turn's close, and a
  session missing from memory is rebuilt from it. When continuity is
  incomplete, the model gets a hidden note: the sandbox was recreated (until
  workspace files are kept), or a turn was cut off before it finished.

## 0.2.0 — trust release

The first release planned by [0145](docs/plans/0145-road-to-external-testers.md):
nothing a first tester touches should lie about state or leak credentials.

### Behaviour changes

- **Mid-turn messages steer the running turn** (#245). A `user.message` sent
  while a turn runs is delivered at the next model-request boundary, inside
  the same turn, as hosted Managed Agents does (probe 70). Previously it waited
  until the turn finished. It can supersede what the first message asked for.
- **User text reaches the model verbatim** (#255). A message starting with
  `/skill:<name>` is no longer expanded by Pi from the control-plane host's
  filesystem.
- **MCP OAuth reauthorize is bound to the connect-time authorization server
  and token endpoint** (#242, #257). A hostile or compromised MCP server can no
  longer redirect reauthorize to obtain the stored client secret or the browser
  redirect. Credentials connected with 0.1.x must be deleted and connected again
  before they can be reauthorized; their runtime token refresh is unaffected.

### Fixes and additions

- `DELETE` right after `session.status_idle` no longer fails while output
  indexing finishes (#240).
- Uploaded files materialize correctly in docker-local sandboxes (#235).
- MCP OAuth console lifecycle: guided connect, status, and reauthorize (#228).

### Platform

- Pi coding agent 0.85.1 (#239).
- Rootless Podman as a docker-local engine (#236).
- Dependency security updates, with a 2-day minimum release age enforced in CI
  (#238, ADR 0017).

### Known issues

- **The model forgets the conversation after 15 idle minutes or a restart**
  (#265). The conversation is held only in memory, and the session continues
  in a fresh sandbox without its earlier files. The event log still shows the
  full history. Fix planned in ADR 0018 stage 1.
- Only connect MCP servers you trust: on a first-time MCP OAuth connect the
  MCP server chooses the authorization server (#257).
- A message sent in narrow windows around a turn's start or end can wait
  until the next message, or end the session's runtime (#260).
- A steered message is recorded when sent, not when the model receives it,
  and is lost if the process stops before delivery (#254).

## 0.1.2

Published README leads with `npx --yes open-managed-agents@latest`.

## 0.1.1

Guided local console onboarding (#224).

## 0.1.0

First public npm package.
