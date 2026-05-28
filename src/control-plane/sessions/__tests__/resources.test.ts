import { describe, expect, it } from "vitest";
import {
  normalizeSessionFileResources,
  normalizeSessionMountPath,
} from "../resources.ts";

describe("session file resource mount paths", () => {
  it.each([
    ["probe.txt", "file_abc", "/mnt/session/uploads/probe.txt"],
    ["data/probe.txt", "file_abc", "/mnt/session/uploads/data/probe.txt"],
    ["/tmp/probe.txt", "file_abc", "/mnt/session/uploads/tmp/probe.txt"],
    [undefined, "file_abc", "/mnt/session/uploads/file_abc"],
  ])("canonicalizes %s", (input, fileId, expected) => {
    expect(normalizeSessionMountPath(input, fileId)).toEqual({
      mountPath: expected,
      segments: expected.replace("/mnt/session/uploads/", "").split("/"),
    });
  });

  it.each([
    ["", "mount_path must not be empty"],
    ["/", "mount_path must not be empty"],
    ["data//probe.txt", "mount_path segment must not be empty"],
    ["./probe.txt", "mount_path must not contain . or .. segments"],
    ["data/../probe.txt", "mount_path must not contain . or .. segments"],
    ["data\\probe.txt", "mount_path must not contain backslashes"],
    ["bad\u0000path", "mount_path must not contain NUL bytes"],
    ["bad path.txt", "mount_path contains unsupported characters"],
    [`${"a".repeat(256)}.txt`, "mount_path segment exceeds 255 characters"],
    [
      `${"a".repeat(250)}/${"b".repeat(250)}/${"c".repeat(250)}/${"d".repeat(250)}/x`,
      "mount_path exceeds 1024 characters",
    ],
  ])("rejects invalid mount_path %j", (input, message) => {
    expect(() => normalizeSessionMountPath(input, "file_abc")).toThrow(message);
  });

  it("rejects duplicate and overlapping canonical resource paths", () => {
    expect(() =>
      normalizeSessionFileResources([
        { fileId: "file_a", mountPath: "data/probe.txt" },
        { fileId: "file_b", mountPath: "/data/probe.txt" },
      ]),
    ).toThrow("Duplicate file resource mount_path");

    expect(() =>
      normalizeSessionFileResources([
        { fileId: "file_a", mountPath: "data" },
        { fileId: "file_b", mountPath: "data/probe.txt" },
      ]),
    ).toThrow("Overlapping file resource mount_path");
  });

  it("allows sibling paths and repeated file ids at distinct paths", () => {
    const normalized = normalizeSessionFileResources([
      { fileId: "file_a", mountPath: "data" },
      { fileId: "file_a", mountPath: "data2/probe.txt" },
    ]);

    expect(normalized.map((resource) => resource.mountPath)).toEqual([
      "/mnt/session/uploads/data",
      "/mnt/session/uploads/data2/probe.txt",
    ]);
  });
});
