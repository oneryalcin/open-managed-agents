export const CMA_GLOB_READY_MARKER = "__OMA_GLOB_READY__";

const MAX_PATTERN_BYTES = 1_024;
const MAX_BRACE_DEPTH = 4;
const MAX_ALTERNATIVES = 64;
const MAX_CLASS_BYTES = 256;
const MAX_COMPILED_STATES = 4_096;

export interface CompiledCmaGlob {
  matches(value: string): boolean;
}

export class CmaGlobReadinessFilter {
  private pending = Buffer.alloc(0);
  ready = false;

  constructor(private readonly expectedToken: string) {}

  push(chunk: Buffer): Buffer | undefined {
    if (this.ready) return chunk;
    this.pending = Buffer.concat([this.pending, chunk]);
    const delimiter = this.pending.indexOf(0);
    if (delimiter < 0) {
      if (this.pending.length > 256) throw new Error("Glob readiness marker exceeds limit");
      return undefined;
    }
    const marker = this.pending.subarray(0, delimiter).toString("utf8");
    if (marker !== this.expectedToken) throw new Error("Invalid glob readiness marker");
    this.ready = true;
    const remainder = this.pending.subarray(delimiter + 1);
    this.pending = Buffer.alloc(0);
    return remainder.length === 0 ? undefined : remainder;
  }

  assertReady(): void {
    if (!this.ready) throw new Error("Glob process did not publish readiness");
  }
}

export class CmaGlobStreamCollector {
  readonly matches: string[] = [];
  private pending = Buffer.alloc(0);
  private rawBytes = 0;
  private outputBytes = 0;
  limitReached = false;

  constructor(
    private readonly matcher: CompiledCmaGlob,
    private readonly opts: {
      root: string;
      maxMatches: number;
      maxRawBytes: number;
      maxOutputBytes: number;
      join: (root: string, relativePath: string) => string;
      formatForOutput?: (absolutePath: string, relativePath: string) => string;
      onLimit: () => void;
    },
  ) {}

  push(chunk: Buffer): void {
    if (this.limitReached) return;
    this.rawBytes += chunk.byteLength;
    if (this.rawBytes > this.opts.maxRawBytes) {
      throw new Error(`Glob enumeration exceeds ${this.opts.maxRawBytes} raw bytes`);
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
      throw new Error("Glob enumeration returned an unterminated filename");
    }
  }

  private accept(record: Buffer): void {
    if (record.includes(0)) throw new Error("Glob filename contains NUL");
    let relativePath = record.toString("utf8");
    if (relativePath.startsWith("./")) relativePath = relativePath.slice(2);
    if (relativePath.length === 0 || !this.matcher.matches(relativePath)) return;
    const absolutePath = this.opts.join(this.opts.root, relativePath);
    const outputPath = this.opts.formatForOutput?.(absolutePath, relativePath) ?? absolutePath;
    const addedBytes = Buffer.byteLength(outputPath, "utf8") +
      (this.matches.length === 0 ? 0 : 1);
    if (this.outputBytes + addedBytes > this.opts.maxOutputBytes) {
      throw new Error(`Glob output exceeds ${this.opts.maxOutputBytes} bytes`);
    }
    this.outputBytes += addedBytes;
    this.matches.push(absolutePath);
    if (this.matches.length >= this.opts.maxMatches) {
      this.limitReached = true;
      this.opts.onLimit();
    }
  }
}

type Token =
  | { type: "literal"; value: string }
  | { type: "star" }
  | { type: "globstar" }
  | { type: "globstarPrefix" }
  | { type: "any" }
  | { type: "class"; negated: boolean; ranges: readonly [number, number][] };

export class CmaGlobPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmaGlobPatternError";
  }
}

export function compileCmaGlob(pattern: string): CompiledCmaGlob {
  if (Buffer.byteLength(pattern, "utf8") > MAX_PATTERN_BYTES) {
    throw patternError(`pattern exceeds ${MAX_PATTERN_BYTES} bytes`);
  }
  assertBraceDepth(pattern);
  const alternatives = expandBraces(pattern);
  // CMA plain patterns match at any descendant basename. Encode that as one
  // NFA prefix instead of rescanning every slash-delimited suffix.
  const tokenSets = alternatives.map((alternative) => [
    { type: "globstarPrefix" } as Token,
    ...tokenize(alternative),
  ]);
  const compiledStates = tokenSets.reduce((total, tokens) => total + tokens.length + 1, 0);
  if (compiledStates > MAX_COMPILED_STATES) {
    throw patternError(`compiled states exceed ${MAX_COMPILED_STATES}`);
  }
  return {
    matches(value: string): boolean {
      // Provider boundaries normalize platform separators. Backslash remains a
      // valid POSIX filename character and must not be rewritten here.
      return tokenSets.some((tokens) => matchTokens(tokens, value));
    },
  };
}

/** Translate CMA's implicit descendant-suffix matching to ripgrep's
 * root-relative glob syntax. Both grammars share the validated wildcard,
 * class, brace, and escape forms used by CMA; the anchoring rule differs. */
export function cmaGlobToRipgrepGlob(pattern: string): string {
  compileCmaGlob(pattern);
  return pattern.startsWith("**/") ? pattern : `**/${pattern}`;
}

function expandBraces(pattern: string): string[] {
  let escaped = false;
  let open = -1;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "}") throw patternError("unmatched closing brace");
    if (char === "{") {
      open = index;
      break;
    }
  }
  if (escaped) throw patternError("trailing escape");
  if (open < 0) return [pattern];

  const parts: string[] = [];
  let nested = 0;
  let partStart = open + 1;
  let close = -1;
  escaped = false;
  for (let index = open + 1; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
    } else if (char === "{") {
      nested += 1;
    } else if (char === "}" && nested > 0) {
      nested -= 1;
    } else if (char === "}" && nested === 0) {
      parts.push(pattern.slice(partStart, index));
      close = index;
      break;
    } else if (char === "," && nested === 0) {
      parts.push(pattern.slice(partStart, index));
      partStart = index + 1;
    }
  }
  if (close < 0) throw patternError("unclosed brace");
  if (parts.length < 2 || parts.some((part) => part.length === 0)) {
    throw patternError("brace expression requires non-empty alternatives");
  }

  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const expanded: string[] = [];
  for (const part of parts) {
    for (const value of expandBraces(`${prefix}${part}${suffix}`)) {
      expanded.push(value);
      if (expanded.length > MAX_ALTERNATIVES) {
        throw patternError(`expanded alternatives exceed ${MAX_ALTERNATIVES}`);
      }
    }
  }
  return expanded;
}

function assertBraceDepth(pattern: string): void {
  let depth = 0;
  let escaped = false;
  for (const char of pattern) {
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "{") {
      depth += 1;
      if (depth > MAX_BRACE_DEPTH) {
        throw patternError(`brace nesting exceeds ${MAX_BRACE_DEPTH}`);
      }
    } else if (char === "}") {
      depth -= 1;
      if (depth < 0) throw patternError("unmatched closing brace");
    }
  }
  if (depth !== 0) throw patternError("unclosed brace");
}

function tokenize(pattern: string): Token[] {
  const tokens: Token[] = [];
  for (let index = 0; index < pattern.length;) {
    const char = pattern[index];
    if (char === "\\") {
      const escaped = codePointAt(pattern, index + 1);
      if (escaped === undefined) throw patternError("trailing escape");
      tokens.push({ type: "literal", value: escaped.value });
      index = escaped.next;
    } else if (char === "*") {
      if (pattern[index + 1] === "*" && pattern[index + 2] === "/") {
        tokens.push({ type: "globstarPrefix" });
        index += 3;
      } else if (pattern[index + 1] === "*") {
        tokens.push({ type: "globstar" });
        index += 2;
      } else {
        tokens.push({ type: "star" });
        index += 1;
      }
    } else if (char === "?") {
      tokens.push({ type: "any" });
      index += 1;
    } else if (char === "[") {
      const parsed = parseClass(pattern, index);
      tokens.push(parsed.token);
      index = parsed.end + 1;
    } else if (char === "]") {
      throw patternError("unmatched closing bracket");
    } else {
      const literal = codePointAt(pattern, index)!;
      tokens.push({ type: "literal", value: literal.value });
      index = literal.next;
    }
  }
  return tokens;
}

function parseClass(pattern: string, start: number): { token: Token; end: number } {
  let end = start + 1;
  let escaped = false;
  for (; end < pattern.length; end += 1) {
    const char = pattern[end];
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === "]") break;
  }
  if (end >= pattern.length) throw patternError("unclosed character class");
  const source = pattern.slice(start + 1, end);
  if (Buffer.byteLength(source, "utf8") > MAX_CLASS_BYTES) {
    throw patternError(`character class exceeds ${MAX_CLASS_BYTES} bytes`);
  }
  let offset = 0;
  const negated = source[0] === "!" || source[0] === "^";
  if (negated) offset = 1;
  const chars: Array<{ codePoint: number; escaped: boolean }> = [];
  while (offset < source.length) {
    let escaped = false;
    if (source[offset] === "\\") {
      escaped = true;
      offset += 1;
      if (offset >= source.length) throw patternError("trailing escape in character class");
    }
    const item = codePointAt(source, offset)!;
    chars.push({ codePoint: item.value.codePointAt(0)!, escaped });
    offset = item.next;
  }
  if (chars.length === 0) throw patternError("empty character class");
  const ranges: [number, number][] = [];
  for (let index = 0; index < chars.length; index += 1) {
    const separator = chars[index + 1];
    if (index + 2 < chars.length && separator.codePoint === 45 && !separator.escaped) {
      if (chars[index].codePoint > chars[index + 2].codePoint) {
        throw patternError("descending character range");
      }
      ranges.push([chars[index].codePoint, chars[index + 2].codePoint]);
      index += 2;
    } else {
      ranges.push([chars[index].codePoint, chars[index].codePoint]);
    }
  }
  return { token: { type: "class", negated, ranges }, end };
}

function matchTokens(tokens: readonly Token[], value: string): boolean {
  const chars = Array.from(value);
  let states = new Set<number>([0]);
  states = epsilonClosure(tokens, states);
  for (const char of chars) {
    const next = new Set<number>();
    for (const state of states) {
      const token = tokens[state];
      if (token === undefined) continue;
      if (token.type === "globstar") next.add(state);
      else if (token.type === "globstarPrefix") {
        next.add(state);
        if (char === "/") next.add(state + 1);
      } else if (token.type === "star" && char !== "/") next.add(state);
      else if (token.type === "any" && char !== "/") next.add(state + 1);
      else if (token.type === "literal" && char === token.value) next.add(state + 1);
      else if (token.type === "class" && char !== "/" && classMatches(token, char)) next.add(state + 1);
    }
    states = epsilonClosure(tokens, next);
    if (states.size === 0) return false;
  }
  return epsilonClosure(tokens, states).has(tokens.length);
}

function epsilonClosure(tokens: readonly Token[], initial: Set<number>): Set<number> {
  const states = new Set(initial);
  const pending = [...states];
  while (pending.length > 0) {
    const state = pending.pop()!;
    const token = tokens[state];
    if (
      (token?.type === "star" || token?.type === "globstar" || token?.type === "globstarPrefix") &&
      !states.has(state + 1)
    ) {
      states.add(state + 1);
      pending.push(state + 1);
    }
  }
  return states;
}

function classMatches(token: Extract<Token, { type: "class" }>, char: string): boolean {
  const codePoint = char.codePointAt(0)!;
  const included = token.ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
  return token.negated ? !included : included;
}

function codePointAt(value: string, index: number): { value: string; next: number } | undefined {
  const codePoint = value.codePointAt(index);
  if (codePoint === undefined) return undefined;
  const character = String.fromCodePoint(codePoint);
  return { value: character, next: index + character.length };
}

function patternError(message: string): CmaGlobPatternError {
  return new CmaGlobPatternError(`Invalid glob pattern: ${message}`);
}
