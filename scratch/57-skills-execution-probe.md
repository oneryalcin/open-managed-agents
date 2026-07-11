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
   Hosted mounts each skill at **`/workspace/skills/<dir>/`** under the workspace
   root. Re-run 2026-07-10 makes this **AUDITABLE** — two independent tool
   results, not the model's paraphrase: a read `tool_use` on
   `/workspace/skills/probe57-6c7ac119/SKILL.md` returned the file body, and a
   bash `tool_result` returned `"/\n/workspace/skills/probe57-6c7ac119/SKILL.md\n"`.
   **HONESTY:** frontmatter `name` and zip top-folder were identical by
   construction here, so this run does NOT distinguish mount-by-`name` from
   mount-by-`directory` (probe 56 shows a separate `directory` field). Which one
   the mount uses when they differ is UNPROBED — OMA sidesteps it by enforcing
   name==dir at upload.

2. **No skill-specific events — AUDITABLE.** Deduped distinct event-type SET (11):
   `user.message`, `agent.thinking`, `agent.tool_use`, `agent.tool_result`,
   `agent.message`, `session.status_running/idle`,
   `session.thread_status_running/idle`, `span.model_request_start/end`;
   `skill_specific_events: []`, `event_count_deduped: 17`. A skill invocation is
   ordinary `tool_use`/`tool_result` traffic — **no new event vocabulary for
   OMA.** (The earlier run's inflated per-type counts were a polling artifact;
   the distinct SET was always valid and this run removes the artifact.)

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
