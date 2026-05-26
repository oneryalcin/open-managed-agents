export const STREAM_TEST_TIMEOUT_MS = 5_000;

export function hasTimedOut(startedAtMs: number, timeoutMs: number): boolean {
  return Date.now() - startedAtMs >= timeoutMs;
}

