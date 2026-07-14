import { relative } from "node:path";
import type { CompiledCmaGlob } from "./cma-glob.ts";
import { toPosix } from "./glob.ts";

export const CMA_GREP_READY_MARKER = "__OMA_GREP_READY__";

export const CMA_GREP_MAX_PATTERN_BYTES = 4_096;
export const CMA_GREP_MAX_PATH_BYTES = 4_096;
export const CMA_GREP_MAX_MATCHES = 100;
export const CMA_GREP_MAX_RAW_BYTES = 1024 * 1024;
export const CMA_GREP_MAX_OUTPUT_BYTES = 64 * 1024;
export const CMA_GREP_TIMEOUT_MS = 10_000;

export class CmaGrepInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmaGrepInputError";
  }
}

export class CmaGrepStreamCollector {
  readonly matches: string[] = [];
  private pending = Buffer.alloc(0);
  private rawBytes = 0;
  private outputBytes = 0;
  limitReached = false;

  constructor(
    private readonly opts: {
      root: string;
      maxMatches: number;
      maxRawBytes: number;
      maxOutputBytes: number;
      matcher?: CompiledCmaGlob;
      join: (root: string, relativePath: string) => string;
      formatForOutput?: (absolutePath: string, relativePath: string) => string;
      onLimit: () => void;
    },
  ) {}

  push(chunk: Buffer): void {
    if (this.limitReached) return;
    this.rawBytes += chunk.byteLength;
    if (this.rawBytes > this.opts.maxRawBytes) {
      throw new Error(`Grep output exceeds ${this.opts.maxRawBytes} raw bytes`);
    }
    this.pending = Buffer.concat([this.pending, chunk]);
    for (;;) {
      const delimiter = this.pending.indexOf(0);
      if (delimiter < 0) return;
      const record = this.pending.subarray(0, delimiter);
      this.pending = this.pending.subarray(delimiter + 1);
      this.accept(record);
      if (this.limitReached) return;
    }
  }

  finish(): void {
    if (!this.limitReached && this.pending.length !== 0) {
      throw new Error("Grep output returned an unterminated filename");
    }
  }

  private accept(record: Buffer): void {
    if (record.includes(0)) throw new Error("Grep filename contains NUL");
    let relativePath = record.toString("utf8");
    if (relativePath.startsWith("./")) relativePath = relativePath.slice(2);
    if (relativePath.length === 0) return;
    if (this.opts.matcher !== undefined && !this.opts.matcher.matches(relativePath)) return;
    const absolutePath = this.opts.join(this.opts.root, relativePath);
    const outputPath = this.opts.formatForOutput?.(absolutePath, relativePath) ?? absolutePath;
    const addedBytes = Buffer.byteLength(outputPath, "utf8") +
      (this.matches.length === 0 ? 0 : 1);
    if (this.outputBytes + addedBytes > this.opts.maxOutputBytes) {
      throw new Error(`Grep output exceeds ${this.opts.maxOutputBytes} bytes`);
    }
    this.outputBytes += addedBytes;
    this.matches.push(absolutePath);
    if (this.matches.length >= this.opts.maxMatches) {
      this.limitReached = true;
      this.opts.onLimit();
    }
  }
}

export function assertCmaGrepPattern(pattern: unknown): string {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new CmaGrepInputError("grep pattern is required");
  }
  if (Buffer.byteLength(pattern, "utf8") > CMA_GREP_MAX_PATTERN_BYTES) {
    throw new CmaGrepInputError(`grep pattern exceeds ${CMA_GREP_MAX_PATTERN_BYTES} bytes`);
  }
  return pattern;
}

export function assertCmaGrepPath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new CmaGrepInputError("grep path is required");
  }
  if (!path.startsWith("/")) {
    throw new CmaGrepInputError("grep path must be absolute");
  }
  if (Buffer.byteLength(path, "utf8") > CMA_GREP_MAX_PATH_BYTES) {
    throw new CmaGrepInputError(`grep path exceeds ${CMA_GREP_MAX_PATH_BYTES} bytes`);
  }
  return path;
}

export function assertCmaGrepContext(context: unknown): number {
  if (context === undefined) return 0;
  if (typeof context !== "number" || !Number.isSafeInteger(context) || context < 0 || context > 100) {
    throw new CmaGrepInputError("grep context must be an integer from 0 through 100");
  }
  return context;
}

export function assertCmaGrepHeadLimit(headLimit: unknown): number {
  if (headLimit === undefined) return CMA_GREP_MAX_MATCHES;
  if (typeof headLimit !== "number" || !Number.isSafeInteger(headLimit) || headLimit < 1 || headLimit > CMA_GREP_MAX_MATCHES) {
    throw new CmaGrepInputError(`grep head_limit must be an integer from 1 through ${CMA_GREP_MAX_MATCHES}`);
  }
  return headLimit;
}

export function formatCmaGrepOutput(matches: readonly string[]): string {
  return matches.length === 0 ? "No matches found" : matches.join("\n");
}

export function outputRelativeTo(base: string, absolutePath: string): string {
  return toPosix(relative(base, absolutePath));
}
