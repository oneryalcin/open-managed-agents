# Changelog

## Unreleased

### Fixes

- **The model keeps the conversation across idle eviction and restarts**
  (#265, plan 0147). Each settled turn is saved with the turn's close, and a
  session missing from memory is rebuilt from it. When continuity is
  incomplete, the model gets a hidden note: the sandbox was recreated (until
  workspace files are kept), or a turn was cut off before it finished.
- **Sessions report usage and time** (plan 0148). `usage` was always `null`;
  it now carries input, output and cache tokens (cache writes split into 5m
  and 1h), `active_seconds`, and `list_cost` in cents, plus a new `stats`
  object (`active_seconds`, `duration_seconds`). Cost is the model cost only,
  estimated from the pinned Pi version's price table, and `null` when a model
  has no known price. Totals are kept by database triggers, so listing
  sessions stays fast with long histories. See PARITY.md for how this
  differs from hosted.
- **A container restarted after a crash boots again** (#276). The appliance
  lock left by the crashed run named PID 1, which is also the restarted
  node's PID, so startup took the stale lock for a live one and refused to
  boot until the file was deleted by hand. The lock is now an exclusive
  SQLite lock on `<db>.oma-lock`, held by the kernel and released when the
  process dies, so no stale-lock guess is needed. A second OMA on the same
  database (another process, another container on the same volume, or a
  symlinked path) is still refused.
- **Session status reports `running` while a turn runs** (#279). `GET` and
  list of sessions said `idle` throughout a turn, because only termination was
  stored on the session. Status now follows the session's latest status event
  (`running`, `idle`, `rescheduling`, `terminated`), as hosted reports it.
- **After a restart, a late tool result or confirmation is accepted at once**
  (#273). Previously it was refused as still owned for up to two minutes, and
  answering several waits of one turn in one request failed.

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
