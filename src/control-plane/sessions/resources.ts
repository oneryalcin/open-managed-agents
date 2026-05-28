import { invalidRequest } from "../errors.ts";

const SESSION_UPLOADS_ROOT = "/mnt/session/uploads";
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_SEGMENT_LENGTH = 255;
const MAX_CANONICAL_MOUNT_PATH_LENGTH = 1024;

export interface NormalizedSessionMountPath {
  mountPath: string;
  segments: string[];
}

export interface SessionFileResourceMountInput {
  fileId: string;
  mountPath?: string;
}

export interface NormalizedSessionFileResourceMount {
  fileId: string;
  mountPath: string;
  segments: string[];
}

export function normalizeSessionMountPath(
  mountPath: string | undefined,
  fileId: string,
): NormalizedSessionMountPath {
  const raw = mountPath ?? fileId;
  if (raw.includes("\0")) {
    throw invalidRequest("Invalid file resource: mount_path must not contain NUL bytes");
  }
  if (raw.includes("\\")) {
    throw invalidRequest("Invalid file resource: mount_path must not contain backslashes");
  }

  const relative = raw.replace(/^\/+/, "");
  if (relative.length === 0) {
    throw invalidRequest("Invalid file resource: mount_path must not be empty");
  }

  const segments = relative.split("/");
  for (const segment of segments) {
    validateSegment(segment);
  }

  const canonical = `${SESSION_UPLOADS_ROOT}/${segments.join("/")}`;
  if (canonical.length > MAX_CANONICAL_MOUNT_PATH_LENGTH) {
    throw invalidRequest("Invalid file resource: mount_path exceeds 1024 characters");
  }
  return { mountPath: canonical, segments };
}

export function normalizeSessionFileResources(
  resources: SessionFileResourceMountInput[],
): NormalizedSessionFileResourceMount[] {
  const normalized = resources.map((resource) => ({
    fileId: resource.fileId,
    ...normalizeSessionMountPath(resource.mountPath, resource.fileId),
  }));
  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      const left = normalized[i]!;
      const right = normalized[j]!;
      if (left.mountPath === right.mountPath) {
        throw invalidRequest("Duplicate file resource mount_path");
      }
      if (isPrefix(left.segments, right.segments) || isPrefix(right.segments, left.segments)) {
        throw invalidRequest("Overlapping file resource mount_path");
      }
    }
  }
  return normalized;
}

function validateSegment(segment: string): void {
  if (segment.length === 0) {
    throw invalidRequest("Invalid file resource: mount_path segment must not be empty");
  }
  if (segment === "." || segment === "..") {
    throw invalidRequest("Invalid file resource: mount_path must not contain . or .. segments");
  }
  if (segment.length > MAX_SEGMENT_LENGTH) {
    throw invalidRequest("Invalid file resource: mount_path segment exceeds 255 characters");
  }
  if (!SEGMENT_PATTERN.test(segment)) {
    throw invalidRequest("Invalid file resource: mount_path contains unsupported characters");
  }
}

function isPrefix(left: string[], right: string[]): boolean {
  return left.length < right.length && left.every((segment, index) => segment === right[index]);
}
