import { describe, expect, it } from "vitest";
import { MANAGED_AGENTS_BETA } from "../api-constants.ts";
import { createInMemoryControlPlaneApp } from "../app.ts";

function request(app: ReturnType<typeof createInMemoryControlPlaneApp>, path: string, init?: RequestInit) {
  return app.request(path, {
    ...init,
    headers: {
      "anthropic-beta": MANAGED_AGENTS_BETA,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

describe("environment networking preset API", () => {
  it("reports an incapable deployment without hiding the offline preset", async () => {
    const app = createInMemoryControlPlaneApp();
    const response = await request(app, "/v1/environments/networking-presets");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      deployment: { egress_supported: boolean };
      presets: Array<{ id: string; networking: { type: string; allowed_hosts: string[] } }>;
    };
    expect(body.deployment.egress_supported).toBe(false);
    expect(body.presets[0]).toMatchObject({
      id: "offline-v1",
      networking: { type: "limited", allowed_hosts: [] },
    });
  });

  it("reports the exact Docker capability used by session admission", async () => {
    const app = createInMemoryControlPlaneApp({
      environmentNetworking: {
        provider: "docker-local",
        egress_supported: true,
        reason: null,
      },
    });
    const response = await request(app, "/v1/environments/networking-presets");
    expect(response.status).toBe(200);
    expect((await response.json() as { deployment: unknown }).deployment).toEqual({
      provider: "docker-local",
      egress_supported: true,
      reason: null,
    });
  });

  it("validates custom hosts without persistence", async () => {
    const app = createInMemoryControlPlaneApp();
    const response = await request(
      app,
      "/v1/environments/networking-presets/validate",
      {
        method: "POST",
        body: JSON.stringify({
          allowed_hosts: ["API.Example.com", "*.Example.org"],
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      allowed_hosts: ["api.example.com", "*.example.org"],
    });

    const environments = await request(app, "/v1/environments");
    expect((await environments.json() as { data: unknown[] }).data).toEqual([]);
  });
});
