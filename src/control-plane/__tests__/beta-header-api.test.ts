import { describe, expect, it } from "vitest";
import {
  createRawInMemoryControlPlaneApp,
  FILES_API_BETA,
  MANAGED_AGENTS_BETA,
} from "./helpers.ts";
import type { ApiErrorBody } from "../errors.ts";

describe("managed agents beta header enforcement", () => {
  it("rejects protected route families before route handling when beta is missing", async () => {
    const app = createRawInMemoryControlPlaneApp();

    for (const path of [
      "/v1/agents",
      "/v1/environments",
      "/v1/files",
      "/v1/sessions",
      "/v1/sessions/sesn_missing/events",
      "/v1/sessions/sesn_missing/events/stream",
    ]) {
      await expectError(
        await app.request(path),
        404,
        "not_found_error",
        "not found",
      );
    }
  });

  it("rejects protected routes when only a different beta is present", async () => {
    const app = createRawInMemoryControlPlaneApp();

    await expectError(
      await app.request("/v1/agents", {
        headers: { "anthropic-beta": "future-beta" },
      }),
      404,
      "not_found_error",
      "not found",
    );
  });

  it("allows protected routes when the managed-agents beta is present with extras", async () => {
    const app = createRawInMemoryControlPlaneApp();

    const res = await app.request("/v1/agents", {
      headers: { "anthropic-beta": `${MANAGED_AGENTS_BETA}, future-beta` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      data: [],
      has_more: false,
      next_page: null,
    });
  });

  it("allows files routes with the files api beta", async () => {
    const app = createRawInMemoryControlPlaneApp();

    const res = await app.request("/v1/files", {
      headers: { "anthropic-beta": FILES_API_BETA },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      data: [],
      has_more: false,
      first_id: null,
      last_id: null,
    });
  });

  it("does not convert unknown routes into beta-gate errors", async () => {
    const app = createRawInMemoryControlPlaneApp();

    await expectError(
      await app.request("/v1/unknown"),
      404,
      "not_found_error",
      "Route not found",
    );
  });

  it("runs the beta gate before request body parsing", async () => {
    const app = createRawInMemoryControlPlaneApp();

    await expectError(
      await app.request("/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      404,
      "not_found_error",
      "not found",
    );
  });
});

async function expectError(
  res: Response,
  status: number,
  type: ApiErrorBody["error"]["type"],
  message: string,
): Promise<void> {
  expect(res.status).toBe(status);
  const requestId = res.headers.get("request-id");
  expect(requestId).toEqual(expect.stringMatching(/^req_/));
  const body = (await res.json()) as ApiErrorBody;
  expect(body).toEqual({
    type: "error",
    error: { type, message },
    request_id: requestId,
  });
}
