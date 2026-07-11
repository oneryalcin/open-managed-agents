# Smoke 59 — OMA skills execution exit proof

Run: `OMA_RUN_SKILLS_LIVE_SMOKE=true npx tsx scratch/59-skills-live-smoke.ts`
with `ANTHROPIC_API_KEY` loaded from the CWC probe environment. Raw result:
`scratch/artifacts/59-skills-live-smoke.json`. Date: 2026-07-11.

The live Docker-backed deployment path passed:

- uploaded the OMA-owned Apache-2.0 example skill;
- attached `version: "latest"`, created a session, then deleted the source
  version before the turn;
- observed real `read` tool use for the snapshotted `SKILL.md`;
- observed real `bash` tool use for the snapshotted executable script;
- observed the exact script result `OMA_SKILLS_LIVE_PROOF=read-and-executed`;
- emitted no skill-specific event vocabulary;
- exposed none of the host-only secret canary or egress trust material;
- proved skill files non-writable and `/workspace/skills` non-replaceable;
- deleted the session and verified the labelled Docker container was removed.

This closes plan 0126's capability exit criterion: an OMA agent can use at
least one skill end to end.
