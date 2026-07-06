// OMA vendor shim: replaces srt's utils/debug. The vendored proxy files import
// `logForDebugging` from here, gated on SRT_DEBUG (kept so upstream call sites
// need no edits). Routed through OMA's logger (0121 C1) so vendor messages get
// the same scrubbing as everything else; `detail` (not `message`) because the
// denylist redacts content-bearing keys and these are proxy-decision strings.
import { log } from "../../logging.ts";

export function logForDebugging(
  message: string,
  options?: { level?: "info" | "warn" | "error" },
): void {
  if (!process.env.SRT_DEBUG) return;
  if (options?.level === "warn") log.warn("egress_vendor_debug", { detail: message });
  else log.error("egress_vendor_debug", { detail: message });
}
