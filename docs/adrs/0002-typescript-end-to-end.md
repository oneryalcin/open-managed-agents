# ADR 0002: TypeScript end-to-end

**Status:** Accepted, 2026-05-21

## Context

Engine choice (Pi, [ADR 0001](0001-use-pi-agent-sdk-as-engine.md)) is TypeScript. The control plane's language is open.

Options:

- **TypeScript** (Hono / Fastify / Express) — single runtime, share types with engine, no RPC boundary.
- **Python** (FastAPI) — familiar, strong async support, but requires RPC/subprocess to talk to a TypeScript Pi.
- **Polyglot** — Python control plane + TypeScript engine sidecar over HTTP or stdin/stdout — every event crosses a process boundary.

## Decision

**TypeScript end-to-end.** Control plane on **Hono**.

## Why Hono specifically

| Property | Why it matters |
|---|---|
| Lightweight (vs. NestJS) | Experiment scope — we don't need DI containers and decorators |
| First-class SSE | `events.stream` is the heaviest endpoint; the framework's SSE story shouldn't be an afterthought |
| Runtime-agnostic | Runs on Node, Bun, Deno, Cloudflare Workers — preserves the option to deploy at the edge later without rewriting |
| Small surface area | Easier to read end-to-end; fewer framework conventions to learn |

## Why not the others

| Option | Why rejected |
|---|---|
| Python FastAPI + TS sidecar | RPC overhead, two runtimes to deploy and debug, two type systems to keep in sync. No clear upside for an experiment. |
| Fastify | Heavier than needed; Hono's runtime-agnosticism is a free option we may want later. |
| NestJS | Decorators + DI overkill for an experiment; opinions we don't need. |
| Express | Mature but SSE plugins are second-class; modern alternatives are cleaner. |
| Bun's `Bun.serve` directly | No middleware ecosystem yet; we want some batteries (routing, validation) without writing them ourselves. |

## Consequences

- TS toolchain: `tsc` for types, `tsup` (or `esbuild`) for bundling, `vitest` for tests, `node` (or `bun`) for runtime.
- Shared `types/` package for Managed Agents API types — likely codegen'd from Anthropic's OpenAPI spec when one is available, hand-rolled otherwise.
- No process boundary between control plane and engine in the MVP — they run in the same Node process. The sandbox is the only genuinely remote dependency.
- We lose the option to share code with a future Python *client* SDK, but the API is HTTP+SSE so any Python client works against it regardless.

## Open questions

- Bun vs Node for the runtime: Bun is faster and has built-in SQLite, but Modal's TypeScript SDK target and Hono compatibility need verification. Defer until MVP is running on Node; consider Bun as a perf pass.
- Whether to publish a thin TypeScript client wrapper around our REST API for ergonomic local use. Not MVP.
