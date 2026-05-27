export function matchGlob(
  values: readonly string[],
  pattern: string,
  opts: {
    ignore?: readonly string[];
    limit?: number;
  } = {},
): string[] {
  const matcher = globMatcher(pattern);
  const ignores = (opts.ignore ?? []).map(globMatcher);
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const out: string[] = [];
  for (const value of values) {
    if (out.length >= limit) break;
    if (ignores.some((ignore) => ignore(value))) continue;
    if (matcher(value)) out.push(value);
  }
  return out;
}

export function globMatcher(pattern: string): (value: string) => boolean {
  const normalized = toPosix(pattern);
  const regex = globToRegexSource(normalized);
  const exact = new RegExp(`^${regex}$`);
  const basename = new RegExp(`(^|/)${regex}$`);
  return (value) => exact.test(toPosix(value)) || basename.test(toPosix(value));
}

function globToRegexSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    const afterNext = pattern[i + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      out += "(?:.*/)?";
      i += 2;
    } else if (char === "*" && next === "*") {
      out += ".*";
      i += 1;
    } else if (char === "*") {
      out += "[^/]*";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

export function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}
