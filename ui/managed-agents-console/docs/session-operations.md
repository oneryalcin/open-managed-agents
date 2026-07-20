# Session operations

> [!NOTE] Status: **Shipped alpha for create, retrieve, list, archive, and delete.**

## Session states

A session is persisted and can be idle, running, rescheduling, or terminated. Runtime activity is observed through events; status is not a promise that a browser still has a live SSE connection.

## Retrieve and list

Use the console or API to retrieve a session and inspect its selected agent reference, environment, events, resources, and timestamps. Session lists support cursor pagination in both directions and preserve the requested order.

## Archive and delete

Archive an idle session to retain its record without continuing work. Delete an idle session only when you no longer need its persisted events and files.

> [!WARNING] OMA rejects archive and delete for a running session. Send an interrupt event or wait for the turn to settle; a rejected deletion does not stop work.

## Operations not available

OMA does not yet support updating a session, changing its agent configuration while idle, or adding and removing session resources after creation.
