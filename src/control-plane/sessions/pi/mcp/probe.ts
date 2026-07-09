import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import {
  knownSecretRepresentations,
  scrubKnownSecrets,
} from "../../../logging.ts";
import type { McpFetch } from "./fetch.ts";

const PROBE_REQUEST_ID = 1;

export interface McpInitializeProbeResponse {
  reached: true;
  statusCode: number;
  contentType: string;
  body: string;
  bodyTruncated: boolean;
  initializeSucceeded: boolean;
}

export type McpInitializeProbeResult =
  | McpInitializeProbeResponse
  | { reached: false };

export async function probeMcpInitialize(
  url: string,
  authorization: string | undefined,
  fetch: McpFetch,
  opts: {
    capBytes: number;
    timeoutMs: number;
    knownSecrets?: readonly string[];
  },
): Promise<McpInitializeProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const headers = new Headers({
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    });
    if (authorization !== undefined) headers.set("authorization", authorization);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: PROBE_REQUEST_ID,
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "open-managed-agents", version: "0" },
          },
        }),
        signal: controller.signal,
      });
    } catch {
      return { reached: false };
    }
    const contentType = response.headers.get("content-type") ?? "";
    let captured: { body: string; truncated: boolean; initializeBody?: string };
    try {
      captured = contentType.toLowerCase().includes("text/event-stream")
        ? await readSseInitialize(response, opts.capBytes)
        : await readCappedBody(response, opts.capBytes);
    } catch {
      captured = { body: "", truncated: true };
    }
    const knownSecrets = opts.knownSecrets ?? [];
    const scrubbedBody = scrubKnownSecrets(captured.body, knownSecrets);
    return {
      reached: true,
      statusCode: response.status,
      contentType: scrubKnownSecrets(contentType, knownSecrets),
      body: captured.truncated
        ? scrubTruncatedSecretSuffix(scrubbedBody, knownSecrets)
        : scrubbedBody,
      bodyTruncated: captured.truncated,
      initializeSucceeded:
        response.ok && isInitializeResult(captured.initializeBody ?? captured.body),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readCappedBody(
  response: Response,
  capBytes: number,
): Promise<{ body: string; truncated: boolean; initializeBody?: string }> {
  if (response.body === null) return { body: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (total < capBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const remaining = capBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
      if (total === capBytes) {
        const contentLengthHeader = response.headers.get("content-length");
        const contentLength = Number(contentLengthHeader);
        truncated =
          contentLengthHeader === null ||
          !Number.isFinite(contentLength) ||
          contentLength > capBytes;
        await reader.cancel();
        break;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return { body: decodeChunks(chunks, total), truncated };
}

async function readSseInitialize(
  response: Response,
  capBytes: number,
): Promise<{ body: string; truncated: boolean; initializeBody?: string }> {
  if (response.body === null) return { body: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let bytesRead = 0;
  let captured = "";
  try {
    while (bytesRead < capBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const remaining = capBytes - bytesRead;
      const part = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytesRead += part.byteLength;
      pending += decoder.decode(part, { stream: true });
      const frames = pending.split(/\r?\n\r?\n/);
      pending = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data.length === 0) continue;
        captured = data;
        if (isResponseForProbe(data)) {
          await reader.cancel();
          return { body: data, truncated: false, initializeBody: data };
        }
      }
      if (value.byteLength > remaining || bytesRead === capBytes) {
        await reader.cancel();
        return { body: captured || pending, truncated: true };
      }
    }
    return { body: captured || pending + decoder.decode(), truncated: false };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function isResponseForProbe(text: string): boolean {
  const value = parseObject(text);
  return value?.jsonrpc === "2.0" && value.id === PROBE_REQUEST_ID;
}

function isInitializeResult(text: string): boolean {
  const value = parseObject(text);
  return (
    value?.jsonrpc === "2.0" &&
    value.id === PROBE_REQUEST_ID &&
    typeof value.result === "object" &&
    value.result !== null &&
    !Array.isArray(value.result)
  );
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function decodeChunks(chunks: readonly Uint8Array[], total: number): string {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function scrubTruncatedSecretSuffix(
  body: string,
  knownSecrets: readonly string[],
): string {
  let matchLength = 0;
  for (const secret of knownSecrets.flatMap(knownSecretRepresentations)) {
    for (let length = Math.min(secret.length, body.length); length > matchLength; length -= 1) {
      if (body.endsWith(secret.slice(0, length))) {
        matchLength = length;
        break;
      }
    }
  }
  return matchLength === 0
    ? body
    : `${body.slice(0, -matchLength)}[redacted]`;
}
