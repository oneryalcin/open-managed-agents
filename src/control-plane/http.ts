import { invalidRequest } from "./errors.ts";

export async function parseJsonBody(req: {
  json(): Promise<unknown>;
}): Promise<unknown> {
  try {
    return await req.json();
  } catch (error) {
    throw invalidRequest("Request body must be valid JSON", String(error));
  }
}

export function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw invalidRequest("`limit` must be a positive integer");
  }
  return limit;
}

export function parseOrder(value: string | undefined): "asc" | "desc" | undefined {
  if (value === undefined) return undefined;
  if (value === "asc" || value === "desc") return value;
  throw invalidRequest("`order` must be `asc` or `desc`");
}
