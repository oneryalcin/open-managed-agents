# Skills

> [!NOTE] Status: **Shipped alpha.** Custom skills are versioned workspace resources delivered to the runtime.

## Create a skill

Upload a skill bundle through the API or console. OMA stores the skill and its versions, validates admission, and snapshots the selected version for runtime use. The API supports creating, listing, retrieving, versioning, and deleting skills.

## Attach a skill to an agent

Reference the desired skill configuration in the agent. A session uses the agent's immutable version, so later agent updates do not change a running or historical session.

## Boundaries

Skills are not arbitrary host access. They run within the selected sandbox and environment policy. Some skill-specific hardening follow-ups remain tracked separately; consult the API reference for the accepted bundle and resource shapes.
