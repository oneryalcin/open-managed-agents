// OMA vendor shim: replaces srt's utils/debug. The vendored proxy files import
// `logForDebugging` from here; we route it to stderr gated on SRT_DEBUG (kept
// so upstream call sites need no edits). Swap to OMA's logger when one exists.
export function logForDebugging(
  message: string,
  options?: { level?: "info" | "warn" | "error" },
): void {
  if (!process.env.SRT_DEBUG) return;
  const line = `[egress-vendor] ${message}`;
  if (options?.level === "warn") console.warn(line);
  else console.error(line);
}
