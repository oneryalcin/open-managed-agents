# ADR 0006: One-time supply-chain quarantine override for Pi 0.75.4

**Status:** Accepted, 2026-05-21

## Context

The user-global npm config enforces `min-release-age=30` — npm refuses to install any package version published less than 30 days ago. This is a deliberate supply-chain defense, modeled on the idea that compromised package versions tend to be caught and yanked within a few weeks of publication.

Pi (`@earendil-works/pi-coding-agent`) has been chosen as our engine ([ADR 0001](0001-use-pi-agent-sdk-as-engine.md)). Its release timeline at decision time:

| Version | Published | Age on 2026-05-21 |
|---|---|---|
| `0.74.0` | 2026-05-07 | 14 days |
| `0.74.1` | 2026-05-16 | 5 days |
| `0.75.0–0.75.3` | 2026-05-17 / 18 | 3–4 days |
| **`0.75.4` (latest)** | 2026-05-20 | **1 day** |

**Every available Pi version is younger than the 30-day quarantine window.** Pi was renamed/republished under `@earendil-works/*` on 2026-05-07, so there's no older mature version to fall back to. Continuing the project requires either (a) waiting ~16 days for `0.74.0` to mature, (b) waiting ~30 days for `0.75.4` to mature, or (c) accepting a deliberate one-time override.

## The security case for `0.75.4` specifically

`0.75.4`'s release notes call out supply-chain hardening as a *named* change:

> **Hardened npm install and release path** — Pi now ships the CLI with a generated shrinkwrap for transitive dependencies, blocks accidental lockfile changes, verifies dependency pinning and lifecycle-script allowlists in checks, disables lifecycle scripts for self-update and local release installs where supported, and smoke-tests isolated npm and Bun installs before release.

Five concrete defenses, all targeting the same threat model our `min-release-age=30` policy guards against. Empirically confirmed at install time: the lockfile entry for `@earendil-works/pi-coding-agent` carries `"hasShrinkwrap": true`, meaning npm honored Pi's transitive-dep pins rather than re-resolving against the registry.

This is a small irony worth naming: **the policy is fighting a release whose contents would improve our own security posture**. Picking an older version (`0.74.0`) wouldn't get us those defenses *and* would still require an override (14 days < 30 days), so it's worse on both axes.

## Decision

**One-time, per-command override of `min-release-age` for the initial install of `0.75.4` only.** No change to the global `~/.npmrc` policy. No `min-release-age-exclude` entry. No project-local `.npmrc` weakening.

Install command used:

```
npm install --min-release-age=0 @earendil-works/pi-coding-agent@0.75.4
```

The override applies only to this single invocation. The user-global policy continues to protect every other package install (project-wide and elsewhere on the machine) without modification.

Result (verified):

```
@earendil-works/pi-coding-agent@0.75.4
sha512-Fb+FRo08b5H9pYKbQJ708/5OKL0+K/yclhfCMEhrBzSPTZZ4c85nY1YsBo4qwL20ohBMlBezHMRuHzcJ1ylEoQ==
```

Lockfile records the SHA-512 tarball integrity hash. Future `npm install` against the committed `package-lock.json` will verify the tarball bytes match this hash; tampering with the tarball after-the-fact (republication attack) cannot pass this check.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Wait ~30 days** for `0.75.4` to mature naturally | Loses project momentum for a known-good, security-hardened release |
| **Add Pi to `min-release-age-exclude`** | Pi is exactly the kind of small-audience package that's a *more* attractive supply-chain target. A permanent exempt sets a precedent we'd repeat for the next "but I really need the latest" package, eroding the policy. |
| **Lower global `min-release-age` to 3 or 7** | Weakens quarantine for every other package. Still wouldn't admit `0.75.4` (1 day old) without an override. Worst of both worlds. |
| **Project-local `.npmrc` weakening** | Scoped, but bypasses the policy for *every* dep in this project, including future ones added without review. The override-per-command pattern keeps each exception explicit and auditable. |

## Consequences

- **Lockfile is the integrity anchor.** `package-lock.json` carries the SHA-512 hash. Anyone running `npm ci` against the committed lockfile gets the exact bytes we installed today (after the policy window passes — see next point).
- **Collaborators / fresh installs before 2026-06-20.** Anyone who runs `npm install` or `npm ci` in this repo before `0.75.4` ages past 30 days will hit the same policy block. They need to use the same explicit override:
  ```
  npm install --min-release-age=0
  ```
  This is by design — the friction signals "you are installing a version that hasn't matured under the global policy."
- **After 2026-06-20**, `npm install` works without the override automatically. Same lockfile, same integrity hash, no policy weakening anywhere.
- **`ignore-scripts=true`** in the global `.npmrc` continues to block any `postinstall` / `preinstall` scripts in Pi or its transitive deps — secondary defense intact.
- **Pi shrinkwrap is honored.** Because `0.75.4` ships an `npm-shrinkwrap.json`, npm uses Pi's own transitive-dep pins rather than re-resolving from semver ranges. We inherit Pi's supply-chain hardening for its tree.
- **Pattern for future updates.** Each Pi upgrade goes through the same gate:
  1. Read the new version's release notes
  2. Decide whether security/feature gains justify an override
  3. If yes: install with explicit `--min-release-age=0` flag, commit lockfile, add a follow-up ADR (or amend this one) documenting the rationale
  4. If no: wait for the version to age past the policy

  **The override is never the default path** — it's a deliberate decision documented in writing each time.

## What this ADR is *not*

- It is **not** a permanent exemption for Pi.
- It is **not** a precedent for any other package.
- It does **not** weaken the global `min-release-age=30` policy in any way.

It is a single, time-bounded, documented exception, with full integrity-hash pinning and a written security rationale. Future "I really need the latest" requests get the same treatment, not an automatic pass.

## Verification

```
$ npm list @earendil-works/pi-coding-agent
open-managed-agents@0.0.1
└── @earendil-works/pi-coding-agent@0.75.4

$ npm audit --audit-level=low
found 0 vulnerabilities

$ grep integrity package-lock.json | head -1
"integrity": "sha512-Fb+FRo08b5H9pYKbQJ708/5OKL0+K/yclhfCMEhrBzSPTZZ4c85nY1YsBo4qwL20ohBMlBezHMRuHzcJ1ylEoQ=="
```
