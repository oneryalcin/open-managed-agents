# Probe 58 — dangling skill versions at agent/session admission

Run: `python3 scratch/58-skills-dangling-session-probe.py`. Raw artifact:
`scratch/artifacts/58-skills-dangling-session-probe.json`. Date: 2026-07-11.

Observed against hosted Managed Agents:

- Attaching an explicit nonexistent version is rejected at agent-create with
  `400 invalid_request_error`: `Agent has invalid configuration: \`skill_id\`
  \`…\` version \`does-not-exist\` not found`.
- Attaching `version: "latest"` succeeds while a version exists.
- After deleting that last version, session-create is rejected with
  `400 invalid_request_error`: `Could not resolve one or more skills: skill
  "…" version "latest" not found`.

Conclusion: hosted validates resolvability both when attaching and again when
creating a session. OMA mirrors both checks; snapshot/materialization remains
slice 3.
