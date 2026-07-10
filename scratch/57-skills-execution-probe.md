# Probe 57 — hosted skill EXECUTION trace (runtime contract)

Run: `python3 scratch/57-skills-execution-probe.py` (key from CWC `.env`). Raw:
`scratch/artifacts/57-skills-execution-probe.json`. Date 2026-07-10. A custom
skill instructs the model to print its own SKILL.md path via bash; we read it
back from the event stream and collect the distinct event vocabulary.

## The three answers

1. **Sandbox mount path (the key runtime unknown):**
   ```
   PROBE57_MOUNT=/workspace/skills/probe57-0a7d3b42/SKILL.md
   ```
   Hosted mounts each skill at **`/workspace/skills/<directory>/`** — under the
   **workspace root** (so the read tool, guarded to `/workspace`, can reach it),
   where `<directory>` = the skill's frontmatter `name` / zip folder. This
   differs from open-ma's `/home/user/.skills/`. **For byte-parity of skills
   that reference their own bundled files, OMA must mount at
   `/workspace/skills/<name>/`.**

2. **No skill-specific events.** Distinct event types over a full run:
   `user.message`, `agent.thinking`, `agent.tool_use` (×6), `agent.tool_result`
   (×4), `agent.message`, `session.status_running/idle`,
   `session.thread_status_running/idle`, `span.model_request_start/end`.
   **`skill_specific_events: []`** — a skill invocation is ordinary
   `tool_use`/`tool_result` (bash/read) traffic. **No new event vocabulary is
   required for OMA.**

3. **Read-tool coupling — location + exact message.** Session create with
   `agent_with_overrides` clearing `tools: []` while skills are attached → **400**:
   > "Missing required tool: skills require the read tool to be usable (enabled
   > and not always_deny) on the session's `agent_toolset`"
   So the coupling is enforced at **session create** (not agent-create, per
   probe 56). Rule: skills require the `read` tool **enabled and not
   `always_deny`** on the session's agent_toolset. Exact message captured for
   error parity.

## Corollaries for the plan

- Delivery seam = materialize skill bytes into the sandbox under
  `/workspace/skills/<name>/` (OMA's `materializeFileResources`, retargeted off
  the uploads root — the constraint both codebase threads flagged).
- Provision-don't-execute confirmed: the model ran the skill via its own bash;
  there is no skill executor.
- Enforcement point for the read-tool coupling: OMA's session-create validation
  (with the `always_deny` tool-permission state considered), not agent-create.
