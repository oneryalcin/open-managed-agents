# Multi-agent orchestration

> [!WARNING] Status: **Not ready in v1.** OMA supports the synchronous single-agent workflow only.

## Current behavior

An agent cannot delegate to a roster, create session threads, or emit thread lifecycle events. Non-null multi-agent configuration is rejected rather than stored as an inert promise.

## What to use instead

Coordinate separate OMA sessions from your own application if needed, but treat that orchestration as application-owned. OMA does not provide coordinator semantics, shared agent context, or CMA-compatible thread APIs today.
