# 0111 Runtime Coordinator Seam Audit

Date: 2026-07-01

Issue: #113

## Purpose

Audit the runtime-change commit paths left behind by the first runtime event
coordinator slice. The failure mode is stale-owner transcript corruption: an old
runtime owner keeps writing rows after a newer owner/generation has claimed the
same runtime turn.

The first coordinator slice fenced the general translated runtime transcript
path through `DeploymentRuntimeEventCoordinator.commitRuntimeEventsForTurn`.
This audit covers the sibling paths that still call
`appendBatchWithRuntimeChanges` directly.

## Load-Bearing Invariants

1. Runtime-originated transcript rows must not commit unless the runtime turn is
   still pending and owned by the writer's `(ownerId, ownerGeneration)`.
2. Any transcript rows and their runtime ledger mutation must commit in one
   SQLite transaction. If the owner/generation update fails, the rows must roll
   back.
3. Lifecycle/user-control paths may close turns without matching the runtime
   owner because they are superseding runtime ownership, not acting as the
   runtime owner.
4. Do not insert an `await` between list/claim/check and the synchronous runtime
   ledger commit path.

## Existing Fences

- `createSingleDatabaseRuntimeEventCoordinator` checks session liveness and
  runtime owner/generation inside the event-store transaction, then calls
  `appendBatchWithRuntimeChangesInTransaction`.
- `EventStore.appendBatchWithRuntimeChanges` wraps event appends and runtime
  ledger changes in one transaction.
- `EventStore.applyRuntimeChanges` throws
  `RuntimeTurnOwnershipLostError` when owner-fenced `turnStates`,
  `leaseRenewals`, `closedTurns`, or model-request-start updates match zero
  rows.
- `src/control-plane/events/__tests__/store.test.ts` already proves stale-owner
  runtime event rows roll back when an owner-fenced runtime change fails.
- `src/control-plane/__tests__/deployment-storage.test.ts` already proves the
  deployment runtime event coordinator rejects stale-owner commits before rows
  are appended.

## Inventory and Rulings

### General Translated Runtime Transcript

Call site:

- `SessionEventService.runRuntimePrompts`, translated Pi event path.

Ruling: already migrated.

Safety argument:

- Commits through `runtimeEventCoordinator.commitRuntimeEventsForTurn`.
- The single-database coordinator checks session liveness and owner/generation
  inside the event-store transaction.
- This remains the strongest seam and should stay the default for ordinary
  translated runtime transcript rows.

### Custom Tool Use Persistence

Call site:

- `SessionEventService.persistCustomToolUse`.

Ruling: store-level fence is sufficient for v1.

Safety argument:

- The persisted row `agent.custom_tool_use`, `openedActions`, and owner-fenced
  `turnStates` commit through one `appendBatchWithRuntimeChanges` transaction.
- A stale owner cannot update `turnStates`; the store throws
  `RuntimeTurnOwnershipLostError` and rolls back the event row plus action row.
- The custom tool event is bound only after the row id is created, and the catch
  path rejects the runtime event if persistence fails.

No coordinator migration is needed unless this path later gains runtime rows
that do not carry an owner-fenced turn mutation.

### Builtin Tool Permission Persistence

Call sites:

- `SessionEventService.persistToolPermissionUse`.
- `SessionEventService.persistToolPermissionUseWithModelEnd`.

Ruling: store-level fence is sufficient for v1.

Safety argument:

- The `agent.tool_use` row and action/turn mutations commit in one
  `appendBatchWithRuntimeChanges` transaction.
- For `ask`, `openedActions` is paired with owner-fenced `turnStates(paused)`.
- For non-ask, the row is paired with owner-fenced `turnStates(running)`.
- The model-end variant also updates `closedModelRequestStarts`, which is
  owner-fenced in the store. If either fence fails, the transaction rolls back.

No coordinator migration is needed unless a future provider emits permission
rows without an owner-fenced turn mutation.

### Lease Renewals

Call site:

- `SessionEventService.startRuntimeLeaseRenewal`.

Ruling: store-level fence is sufficient.

Safety argument:

- Lease renewal writes no transcript rows.
- The `leaseRenewals` mutation is owner-fenced by `(turnId, ownerId,
  ownerGeneration)`.
- On ownership loss, the interval logs and stops renewing.

Coordinator migration would not add useful transcript protection here.

### Runtime Turn State Marking

Call site:

- `SessionEventService.markRuntimeTurnState`.

Ruling: store-level fence is sufficient.

Safety argument:

- Dispatching/running/paused state marks write no transcript rows.
- `turnStates` is owner-fenced by the store.
- On stale owner, the store throws and the caller's existing runtime error path
  handles the loss.

### Runtime Error Cleanup and Synthetic Span-End Persistence

Call sites:

- `runRuntimePrompts` catch block for active prompt errors.
- `closeRuntimeTurnWithSyntheticSpanEnds`.

Ruling: store-level fence is sufficient for v1.

Safety argument:

- When these paths append synthetic span-end, `session.error`, or
  `session.status_idle` rows, the same transaction includes an owner-fenced
  `closedTurns` mutation.
- If a newer owner has claimed the turn or lifecycle has already terminalized
  it, `closedTurns` matches zero rows and the event rows roll back.
- If the session is already process-locally closed/deleted, the active-prompt
  error path writes only runtime ledger cleanup, with no transcript rows.

This is a defensive cleanup path, not the primary translated transcript path.
Keep it synchronous and owner-fenced.

### Terminalization and Recovery Paths

Call sites:

- `recoverAbandonedRuntimeTurns`.
- `claimAcceptedTurn`.
- `claimTurnForTerminalization`.
- `terminalizeAbandonedRuntimeTurn`.
- custom-tool and tool-confirmation terminalization rows built during
  `sendEvents`.

Ruling: current claim-plus-store-fence pattern is sufficient.

Safety argument:

- Recovery first claims accepted/expired turns with store methods that move the
  turn to the current owner/generation.
- Terminalization rows are paired with owner-fenced `closedTurns`.
- If another owner or lifecycle path closes the turn before terminalization rows
  commit, the store-level owner fence rolls back the rows.
- User-submitted custom tool result and tool confirmation terminalization paths
  claim expired turns before producing synthetic terminalization rows. The final
  commit is still owner-fenced through `closedTurns`.

### Lifecycle Guard Cleanup

Call sites:

- `closePendingRuntimeTurnsForSession`.
- deletion/archive paths that close all pending runtime turns.
- `closeInterruptedRuntimeActions`.
- `closeReleasedRuntimeAction`.

Ruling: no runtime-owner coordinator should be added.

Safety argument:

- Archive/delete/interrupt are lifecycle or user-control operations that
  intentionally supersede runtime ownership.
- `closePendingRuntimeTurnsForSession` deliberately closes turns without
  owner/generation because it is not acting as the runtime owner. Its in-code
  comment correctly requires the list-and-close operation to stay synchronous.
- `closeInterruptedRuntimeActions` appends synthetic span ends only with
  owner-fenced `closedTurns`, so stale turn records roll back rows.
- `closeReleasedRuntimeAction` closes action ledger rows only; it writes no
  transcript rows.

Adding the runtime event coordinator here would be the wrong abstraction: it
would make lifecycle operations depend on stale runtime ownership instead of
terminating it.

### Session Output Collection

Call sites:

- `indexSessionOutputsFromLiveRuntime`.
- `DeploymentSessionOutputCoordinator.replaceSessionOutputsForRuntimeTurn`.

Ruling: already has the correct separate coordinator.

Safety argument:

- Session outputs are file metadata/object writes, not transcript rows.
- The runtime path performs a cheap process-local owner check and then commits
  through the session-output coordinator.
- The durable coordinator checks runtime owner/generation in the same file-store
  transaction that replaces output metadata.

## Conclusion

No new runtime event coordinator migration is required for #113.

The remaining direct `appendBatchWithRuntimeChanges` call sites are either:

- transcript-writing paths paired with an owner-fenced runtime mutation in the
  same event-store transaction;
- ledger-only paths with no transcript rows; or
- lifecycle/user-control paths that intentionally supersede runtime ownership.

The key test coverage already exists:

- store-level rollback for stale-owner transcript rows and stale span/model-start
  mutations;
- deployment coordinator stale-owner rejection before transcript append;
- API coverage for lost custom-tool/tool-confirmation terminalization.

Future rule: if a new runtime-originated transcript path does not naturally pair
its rows with an owner-fenced `turnStates`, `closedTurns`, or model-request-start
mutation, it must use `DeploymentRuntimeEventCoordinator` rather than calling
`appendBatchWithRuntimeChanges` directly.
