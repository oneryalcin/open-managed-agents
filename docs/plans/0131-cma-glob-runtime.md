# Plan 0131 — Sandbox-backed CMA `glob`

Date: 2026-07-13
Status: implemented in PR #184; awaiting final architecture review
Branch: `arc-g-cma-glob-probe`
Evidence: [probe 65](../../scratch/65-managed-agents-glob-edge-probe.md),
[probe 65b](../../scratch/65b-managed-agents-glob-pattern-probe.md)

## Goal

Expose CMA's `glob` builtin through a bounded, cancellable, provider-owned
operation. Do not alias Pi's `find` definition and do not call the existing
`FindOperations.glob` from a public `glob` invocation: that would record a
`find` operation under an active `glob` context and correctly trip the runner's
sandbox-bypass protection.

`grep` is out of scope and remains deployment-disabled until providers own
content search.

## Hosted contract observed by probes 64, 65, and 65b

- Input schema: required string `pattern`; optional string `path`.
- Omitted path uses the runtime working directory. Relative path is accepted and
  resolved from that directory. Explicit absolute paths produce absolute
  output; explicit relative paths and omission produce relative output.
- Plain patterns recurse. `**` also matches root and nested files.
- Tested grammar supports `*`, `**`, `?`, character classes/ranges, and brace
  alternatives.
- Backslash escaping of metacharacters is supported: correlated calls proved
  escaped `?` and brackets match literal characters.
- Dotfiles, `.gitignore` matches, and `node_modules` matches are not filtered in
  the tested corpus.
- Results are newline-delimited text, silently capped at 100 matches. No matches
  is the successful text `No files found`.
- Missing paths and malformed patterns are error tool results.
- Ordering was not lexical and is not treated as stable from one observation.
- Calls use builtin permission evaluation and ordinary events named `glob`.

## Provider operation and accounting

Add an OMA-owned operation separate from upstream `FindOperations`:

```ts
interface CmaGlobOperations {
  glob(input: {
    pattern: string;
    cwd: string;
    signal: AbortSignal;
    maxMatches: 100;
    maxOutputBytes: number;
    timeoutMs: number;
  }): Promise<string[]>;
}
```

Add it to `SandboxOperations` as `glob` and add `glob` to
`SandboxedBuiltinToolName`. Every host-passthrough, Docker, and microsandbox
implementation must call `recordSandboxInvocation(..., "glob")` before work.
The active tool context, invocation stats, and provider operation will therefore
agree on `glob`; no accounting alias or bypass exception is permitted.

The existing find enumeration/matching code may be factored into shared private
helpers, but the public glob operation must not call an operation that records
`find`.

## Bounded and cancellable execution

The existing Docker/microsandbox `find ... | sort` path buffers a complete
filesystem listing before applying a visible limit and is not suitable.
Provider implementations must instead:

1. stream enumeration output rather than buffer the complete tree;
2. match incrementally and terminate enumeration after 100 matches;
3. enforce a fixed raw/output-byte ceiling even before 100 matches;
4. enforce a provider timeout;
5. accept the invocation `AbortSignal` and terminate the active Docker exec or
   microsandbox command on abort, awaiting process cleanup;
6. reject over-limit, timeout, and cancellation paths as bounded tool errors.

This requires cancellable execution primitives for Docker and microsandbox; a
pre/post cancellation check around `FindOperations.glob` is insufficient.
Provider tests must prove the underlying command is terminated, not merely that
its eventual result is ignored. The per-call UUID is a correlation token, not
a secret or authentication credential: sandbox processes can read and copy it.
Cleanup therefore targets only process groups carrying the exact token, while a
pre-readiness cancellation poisons and disposes the entire sandbox boundary so
delayed dispatch cannot outlive the operation.

The unsafe host-passthrough provider is an explicit test/development exception
to the no-host-read invariant. It still needs bounded traversal, timeout, byte
limits, signal handling, and `glob` accounting.

## Pattern grammar and formatting

Implement and test a dedicated grammar for `*`, `**`, `?`, classes/ranges,
brace alternatives, and backslash escaping. Reject malformed constructs and do
not silently reinterpret unsupported patterns. Keep the matcher free of
implicit ignore rules.

Bound matcher complexity before enumeration: UTF-8 pattern length at most 1,024
bytes; brace nesting at most 4 levels; at most 64 total expanded alternatives;
and at most 256 source bytes per character class. Parse iteratively into tokens
and use a linear-time or explicitly state-bounded matcher. Do not generate a
single backtracking regular expression or eagerly expand beyond the alternative
cap. Complexity-limit violations are tool errors and must occur before starting
a provider command.

Resolve `path` inside the provider workspace boundary. Format matches according
to whether `path` was supplied, return `No files found` for an empty result, and
preserve provider order unless later evidence establishes a sorting contract.
Exact hosted shell/`rg` error strings are not portable requirements.

## Public tool decision

CMA `glob` replaces Pi `find` in the model-facing sandbox tool list. Retain
shared private enumeration helpers and any internal `find` operation needed by
non-model code, but do not register `createFindToolDefinition` for agent
sessions. `find` remains rejected by CMA agent configuration and is not a
documented OMA extension. This removes the current mismatch where a model can
see a tool that clients cannot configure.

## Tests

- Definition/schema tests: required `pattern`, optional `path`, unknown fields.
- Grammar tests: `*`, `**`, `?`, classes, ranges, braces, backslash escaping,
  malformed constructs, and every pattern-complexity bound.
- Formatting tests: no matches, explicit absolute/relative/omitted path,
  recursion, dotfiles, no ignores, 100 matches, and byte ceiling.
- Accounting/bypass tests proving `glob` context records exactly one validated
  `glob` provider invocation and never a `find` invocation.
- Cancellation and timeout tests proving active Docker/microsandbox commands are
  terminated; stress tests proving enumeration stops early.
- Permission, confirmation, and event tests proving the public name is `glob`.
- Real Docker and microsandbox parity tests, plus bounded unsafe-host tests.
- Agent API regression: remove only `glob` from deployment-disabled defaults;
  `grep`, `web_fetch`, and `web_search` retain effective-enablement rejection.

## Acceptance criteria

- No accepted `glob` configuration is inert.
- Accounting validates `glob` without aliases or bypass exceptions.
- Docker and microsandbox perform no glob filesystem reads or search processes
  on the control-plane host; unsafe host passthrough remains explicitly unsafe.
- Enumeration is streaming, match- and byte-bounded, timed out, and actively
  cancellable in every provider.
- Both sandbox providers pass equivalent grammar and formatting tests.
- Pi `find` is no longer model-facing.
- Legacy rows remain readable and `grep` remains rejected when enabled.
