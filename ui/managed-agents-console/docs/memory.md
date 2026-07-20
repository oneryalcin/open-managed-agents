# Using agent memory

> [!WARNING] Status: **Not ready in v1.** OMA has no memory-store, memory-version, or cross-session memory resource API.

## Current behavior

Each session has its own persisted event record and explicitly attached input files. That persistence helps inspection and replay, but it is not agent memory that can be mounted into a later session.

## Compatibility note

Memory-store resources are rejected at the session-resource boundary. Do not build an integration around CMA memory endpoints or paths until OMA ships the underlying storage, access, versioning, and audit semantics.
