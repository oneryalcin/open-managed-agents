import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { open, seal } from "../envelope.ts";

// The store's epoch check (secrets_config) normally rejects a wrong key before
// any envelope call, so the envelope's own kek diagnosis is defense in depth —
// it fires if a mixed-key row ever exists anyway (e.g. a restored backup from
// before a rotation). Lock it here so a refactor can't silently drop it back
// to a bare GCM failure.
describe("envelope kek diagnosis", () => {
  it("open with a different master key names the kek mismatch, not GCM garbage", () => {
    const sealed = seal(randomBytes(32), "rec-1", Buffer.from("value"));
    expect(() => open(randomBytes(32), "rec-1", sealed)).toThrow(
      /sealed under a different master key/,
    );
  });
});
