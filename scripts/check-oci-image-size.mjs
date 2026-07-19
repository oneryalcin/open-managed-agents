#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const TARGET_PLATFORMS = new Set(["linux/amd64", "linux/arm64"]);

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

export async function measureOciImage(ref, inspectRaw) {
  const root = parseJson(await inspectRaw(ref), ref);
  if (!Array.isArray(root.manifests)) {
    return [{ platform: "single-platform", bytes: manifestBytes(root) }];
  }

  const selected = root.manifests.filter((entry) => {
    const platform = `${entry.platform?.os ?? ""}/${entry.platform?.architecture ?? ""}`;
    return TARGET_PLATFORMS.has(platform);
  });
  if (selected.length !== TARGET_PLATFORMS.size) {
    throw new Error(
      `expected linux/amd64 and linux/arm64 manifests, found ${selected
        .map((entry) => `${entry.platform?.os}/${entry.platform?.architecture}`)
        .join(", ") || "none"}`,
    );
  }

  return Promise.all(selected.map(async (entry) => {
    const platform = `${entry.platform.os}/${entry.platform.architecture}`;
    const manifest = parseJson(await inspectRaw(`${ref.split("@")[0]}@${entry.digest}`), platform);
    return { platform, bytes: manifestBytes(manifest) };
  }));
}

function manifestBytes(manifest) {
  if (!Array.isArray(manifest.layers)) {
    throw new Error("OCI image manifest has no layers");
  }
  return (manifest.config?.size ?? 0) + manifest.layers.reduce((sum, layer) => {
    if (!Number.isSafeInteger(layer.size) || layer.size < 0) {
      throw new Error("OCI image layer has an invalid size");
    }
    return sum + layer.size;
  }, 0);
}

function dockerInspectRaw(ref) {
  const result = spawnSync(
    "docker",
    ["buildx", "imagetools", "inspect", "--raw", ref],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `failed to inspect ${ref}`);
  }
  return result.stdout;
}

async function main() {
  const [ref, limitText = "314572800"] = process.argv.slice(2);
  const limit = Number(limitText);
  if (!ref || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("usage: check-oci-image-size.mjs <image-ref> [max-compressed-bytes]");
  }
  const sizes = await measureOciImage(ref, dockerInspectRaw);
  let exceeded = false;
  for (const size of sizes) {
    const mib = (size.bytes / 1024 / 1024).toFixed(2);
    console.log(`${size.platform}: ${mib} MiB compressed`);
    exceeded ||= size.bytes > limit;
  }
  if (exceeded) {
    throw new Error(`sandbox image exceeds ${(limit / 1024 / 1024).toFixed(2)} MiB compressed`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
