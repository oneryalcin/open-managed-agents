# Tools, files, and skills

OMA gives coding agents a deliberately bounded sandbox toolset and persistent inspection surfaces.

## Built-in tools

The alpha coding image supports Bash plus read, write, edit, glob, and provider-owned grep. It includes Node/npm, Python/uv, Git, curl, jq, common compilers, and archive tools.

## Files and skills

Attach files and skills to the agent/session workflow, then inspect workspace uploads and session-scoped output files from the console. Current file-mount limits and path semantics remain documented alpha differences from CMA.

> [!WARNING] A session currently accepts at most 10 mounted files, not CMA's documented 100. OMA also rewrites mount paths under its session uploads root.

## Web tools

> [!WARNING] Web search and web fetch are not yet enabled. Approved Docker egress does not turn them into provider-owned tools.
