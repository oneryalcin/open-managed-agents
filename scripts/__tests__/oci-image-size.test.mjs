import { describe, expect, it } from "vitest";
import { measureOciImage } from "../check-oci-image-size.mjs";

describe("OCI image compressed-size measurement", () => {
  it("sums config and layer bytes for the two runtime platforms only", async () => {
    const documents = new Map([
      ["image@sha256:index", {
        manifests: [
          { digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } },
          { digest: "sha256:arm", platform: { os: "linux", architecture: "arm64" } },
          { digest: "sha256:sbom", platform: { os: "unknown", architecture: "unknown" } },
        ],
      }],
      ["image@sha256:amd", { config: { size: 2 }, layers: [{ size: 3 }, { size: 5 }] }],
      ["image@sha256:arm", { config: { size: 7 }, layers: [{ size: 11 }] }],
    ]);
    await expect(measureOciImage("image@sha256:index", async (ref) =>
      JSON.stringify(documents.get(ref)),
    )).resolves.toEqual([
      { platform: "linux/amd64", bytes: 10 },
      { platform: "linux/arm64", bytes: 18 },
    ]);
  });

  it("fails closed when a required platform is missing", async () => {
    await expect(measureOciImage("image@sha256:index", async () => JSON.stringify({
      manifests: [
        { digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } },
      ],
    }))).rejects.toThrow("expected linux/amd64 and linux/arm64 manifests");
  });
});
