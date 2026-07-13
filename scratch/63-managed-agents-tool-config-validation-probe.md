# Probe 63 — hosted tool-config validation and precedence

Date: 2026-07-13  
Status: complete  
Artifact: `scratch/artifacts/63-managed-agents-tool-config-validation-probe.json`

## Question

OMA currently accepts arbitrary `agent_toolset_20260401.configs[].name` and
permission-policy strings. The values can round-trip while having no runtime
effect. Before closing those sets, capture hosted CMA behavior for:

- unknown builtin tool names;
- unknown permission-policy types;
- duplicate tool configs and duplicate toolsets;
- combinations of invalid fields, to establish validation/error precedence;
- a candidate vocabulary of documented builtin tool names and policy values.

## Method

The probe creates short-lived agents only; it does not create sessions or run
models. Each case records accepted/rejected status, HTTP status, error type and
message, or a redacted response shape. Agent IDs are not written to the artifact.
Every unexpectedly accepted agent is archived immediately.

Run:

```bash
uv run --with anthropic python scratch/63-managed-agents-tool-config-validation-probe.py
```

The script reads `ANTHROPIC_API_KEY` from the existing local probe env file and
writes the raw result to the artifact path above. Scrub organization-scoped
values before publishing the artifact externally.

## Cases

The matrix includes isolated unknown-name/policy cases, duplicate same-name and
conflicting-policy cases, duplicate toolset entries, and mixed-invalid requests
for precedence. Candidate names include `bash`, `read`, `write`, `edit`,
`glob`, `grep`, `web_fetch`, `web_search`, and `find`; policy candidates include
`always_allow`, `always_ask`, `never_allow`, `always_deny`, `deny`, and an
unknown sentinel.

## Findings

All tested validation failures returned HTTP 400 with `invalid_request_error`.
The hosted behavior observed in the artifact is:

| Question | Result |
|---|---|
| Builtin tool vocabulary | Exactly `bash`, `edit`, `glob`, `grep`, `read`, `web_fetch`, `web_search`, `write` accepted. `find` rejected with an explicit expected-values message. |
| Unknown `configs[].name` | Rejected before persistence: `"…" is not a valid value; expected one of …`. |
| Permission-policy vocabulary | Only `always_allow` and `always_ask` accepted in the tested `default_config`. `never_allow`, `always_deny`, `deny`, and the sentinel unknown value rejected. |
| Omitted default config | Accepted and response materializes `default_config.enabled: true`, `permission_policy.type: "always_allow"`, plus `configs: []`. |
| Duplicate config names | Same-name and conflicting-policy duplicates rejected. The message uses the internal hosted tool identifier, e.g. `AGENT_TOOL_NAME_BASH`. |
| Duplicate agent toolsets | Rejected: at most one `agent_toolset_20260401` is allowed. |
| Unknown tool + unknown policy in one config | Unknown permission policy wins. |
| Duplicate + unknown policy | Unknown permission policy wins over duplicate detection. |
| Unknown config tool + malformed default policy | Unknown config tool wins. |
| Malformed config name + unknown default policy | Unknown default policy wins. |

The mixed-invalid cases demonstrate that precedence is path/order-sensitive;
do not collapse the findings into a general “tool names before policies” rule.
The exact messages and values are preserved in the artifact for the OMA
validation slice. The artifact intentionally omits created agent IDs.
