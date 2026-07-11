---
name: oma-example-skill
description: Use this skill whenever the user asks for the OMA skills smoke proof.
---

# OMA example skill

This Apache-2.0 example skill proves that OMA advertises session-snapshotted
skills and mounts their files in the sandbox.

When asked for the OMA skills smoke proof:

1. Use the `read` tool on `/workspace/skills/oma-example-skill/SKILL.md`.
2. Use `bash` to run `/workspace/skills/oma-example-skill/scripts/prove.sh`.
3. Reply with exactly the script output.
