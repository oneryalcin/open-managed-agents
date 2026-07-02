# References

## Anthropic Managed Agents (the API we're cloning)

- Overview: https://platform.claude.com/docs/en/managed-agents/overview
- Quickstart: https://platform.claude.com/docs/en/managed-agents/quickstart
- Agent setup: https://platform.claude.com/docs/en/managed-agents/agent-setup
- Sessions: https://platform.claude.com/docs/en/managed-agents/sessions
- Events & streaming: https://platform.claude.com/docs/en/managed-agents/events-and-streaming
- Environments: https://platform.claude.com/docs/en/managed-agents/environments
- Tools: https://platform.claude.com/docs/en/managed-agents/tools
- Self-hosted sandboxes: https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes
- Webhooks: https://platform.claude.com/docs/en/managed-agents/webhooks
- Multiagent: https://platform.claude.com/docs/en/managed-agents/multi-agent
- Memory stores: https://platform.claude.com/docs/en/managed-agents/memory
- Vaults: https://platform.claude.com/docs/en/managed-agents/vaults
- Define outcomes: https://platform.claude.com/docs/en/managed-agents/define-outcomes
- Resources live-probe notes: [managed-agents-resources-notes.md](references/managed-agents-resources-notes.md)
- File storage prior-art notes: [file-storage-prior-art.md](references/file-storage-prior-art.md)
- Competing OMA implementations (open-ma / openma.dev) prior-art: [oma-implementations-prior-art.md](references/oma-implementations-prior-art.md)
- just-bash (simulated-bash sandbox) prior-art: [just-bash-prior-art.md](references/just-bash-prior-art.md)
- agentOS (Pi-native in-process runtime) + Osaurus (Apple-Containerization sandbox) prior-art: [agentos-osaurus-prior-art.md](references/agentos-osaurus-prior-art.md)
- Egress proxy + secrets storage buy-vs-build survey: [egress-secrets-buy-vs-build.md](references/egress-secrets-buy-vs-build.md)

## Anthropic SDK source (for endpoint shapes and types)

- Python: https://github.com/anthropics/anthropic-sdk-python
- TypeScript: https://github.com/anthropics/anthropic-sdk-typescript

## Pi Agent SDK (the engine)

- Docs: https://pi.dev/docs/latest/sdk
- npm: `@earendil-works/pi-coding-agent`
- Core types likely live in: `@earendil-works/pi-agent-core` (referenced from SDK docs as the source of `Agent`, `AgentTool`, `AgentState`)

## Infrastructure

- OpenAI Agents sandbox guide: https://developers.openai.com/api/docs/guides/agents/sandboxes
- Modal Sandboxes: https://modal.com/docs/guide/sandbox
- Modal TypeScript SDK: https://github.com/modal-labs/modal-js
- Canonical Workshop announcement: https://discourse.ubuntu.com/t/introducing-workshop-launch-sandboxed-development-environments-on-ubuntu-with-a-single-command/83322
- Canonical Workshop docs: https://documentation.ubuntu.com/canonical-workshop/latest/
- Hono: https://hono.dev
- Hono SSE: https://hono.dev/docs/helpers/streaming#sse
- Better-SQLite3: https://github.com/WiseLibs/better-sqlite3

## Anthropic CLI (`ant`)

The official CLI exposes every Managed Agents endpoint as a subcommand. Useful for poking the upstream API to verify event shapes before cloning them.

- CLI docs: https://platform.claude.com/docs/en/api/sdks/cli

## Related projects (evaluated, not used)

| Project | What it is | Why not for this |
|---|---|---|
| [Claude Agent SDK (Python)](https://github.com/anthropics/anthropic-quickstarts) | Mature SDK that spawns the Claude Code CLI as a subprocess. Local-first. | Wrong shape for a hosted multi-tenant platform — designed for "agent runs on your laptop," not "you run an agent platform for others." |
| [Flue](https://github.com/withastro/flue) (`@flue/runtime`) | TypeScript agent harness framework from the Astro team. Built-in sandbox connectors (local, Daytona, Cloudflare). | Framework-shaped (imposes `.flue/agents/*.ts` filesystem convention); marked Experimental; agent definitions are TS files, not API objects — fights the persisted-agent model. |
| [OpenClaw](https://github.com/OpenClaw/OpenClaw) | Pi-based agent runner with Docker/SSH/managed-remote sandbox backends, filesystem bridges, and provider-owned tool wiring. | Useful sandbox backend prior art, not a platform dependency. Borrow backend/lifecycle lessons; do not copy its embedded runner, channel delivery, transcript repair, or non-Managed-Agents event surface. Evaluated at `3e351b71`; see ADR 0003. |
| [rogeriochaves/open-managed-agents](https://github.com/rogeriochaves/open-managed-agents) | Full-stack self-hosted agent platform with Hono, React UI, OpenAPI/Zod schemas, BDD specs, provider abstractions, MCP routing, governance, and Helm packaging. | Useful contract-test prior art, especially BDD specs and event/schema/type alignment lints. Do not copy its engine loop, timestamp cursoring, UI-first scope, or non-Pi provider architecture. Evaluated at `e9a0743`; see ADR 0008. |
| [InsForge](https://github.com/InsForge/InsForge) | Apache-2.0 BaaS designed *for AI coding agents to consume* (Postgres + Auth + Storage + Edge Functions via MCP). | Solving the inverse problem — provides a backend *for* agents to drive, not a platform *to run* agents on. Used backwards, it's just a less-mature Supabase. |
| ["The Log is the Agent" / ActiveGraph](https://arxiv.org/abs/2605.21997) (Nakajima, May 2026) | Event-sourced agent runtime: append-only log is source of truth, graph state is a deterministic projection, and a content-addressed model/tool response cache makes runs byte-reproducible — enabling deterministic replay, cheap forking (branch a run at any event without re-executing the prefix), and total goal→artifact lineage. | Architecture/position paper, not for adoption — its reactive-graph/no-orchestrator model is a different agent shape than our Pi-loop, Anthropic-compatible control plane. Carry forward only as future-directions input for our own event log (ADR 0009): the content-addressed response cache is the concrete mechanism *if* we ever want session replay or fork-and-diff-as-evaluation; its unresolved frontiers (multi-writer ordering, replay-cost/compaction) are ours too. Conceptual ("discussed, not demonstrated"). |
| [Gemini Managed Agents — sandbox/environment model](https://ai.google.dev/gemini-api/docs/agent-environment) ([guide](https://www.philschmid.de/gemini-managed-agents-developer-guide)) | Hosted Linux sandbox keyed by an `environment_id` that is separate from the conversation `interaction.id`; lifecycle Created→Active→Idle→Offline→Deleted (idle-snapshot ~15min, resumable ~7d, tar download); `sources` (git/GCS/inline) mount inputs; default-open outbound network with an optional allowlist; an egress proxy injects credentials so secrets never live inside the sandbox. | Hosted managed-environment product, ahead of our scope — not for the current Docker-local/provider-selection path. Carry forward for the future resource-grant design (see ADR 0003): egress-proxy secret injection is the sharp replacement for the env allowlist; adopt its network-allowlist *mechanism* but keep our default-deny *posture*; durable resumable workspace state is a deliberate future fork vs our session-ephemeral sandbox. |

## Internal Claude API skill docs consulted

These are the docs we read while making design decisions. They're loaded into the `/claude-api` skill — pulling them from there is the canonical way to refresh:

- `shared/managed-agents-overview.md` — architecture, mandatory agent-first flow, beta headers
- `shared/managed-agents-core.md` — agent + session object shapes, lifecycle
- `shared/managed-agents-events.md` — event types, streaming patterns
- `shared/managed-agents-tools.md` — server-vs-client tools, MCP, vaults
- `shared/managed-agents-client-patterns.md` — reconnect, pending-call gating, custom-tool round-trip
- `shared/managed-agents-self-hosted-sandboxes.md` — the inverse model (loop on Anthropic, sandbox on you)
- `shared/managed-agents-api-reference.md` — endpoint and SDK-method reference
