import type {
  ManagedAgentsSpanModelRequestEndPayload,
  ManagedAgentsSpanModelUsage,
} from "../../../types/events.ts";
import type { JsonObject } from "../../../types/json.ts";
import type { EventDraft } from "./translator.ts";

export const zeroModelUsage: ManagedAgentsSpanModelUsage = {
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  input_tokens: 0,
  output_tokens: 0,
};

export function spanModelRequestStartDraft(input: unknown): EventDraft[] {
  const message = assistantMessage(input);
  if (!message || eventType(input) !== "message_start") return [];
  if (!hasModelRequestMetadata(message)) return [];
  return [{ type: "span.model_request_start", payload: {} }];
}

export function spanModelRequestEndDraft(
  input: unknown,
  startEventId: string | undefined,
): EventDraft[] {
  const message = assistantMessage(input);
  if (!message || eventType(input) !== "message_end") return [];
  if (!startEventId) return [];
  const payload: ManagedAgentsSpanModelRequestEndPayload = {
    model_request_start_id: startEventId,
    is_error: message.stopReason === "aborted" || message.stopReason === "error",
    model_usage: usageFromMessage(message),
  };
  return [{ type: "span.model_request_end", payload: toJsonObject(payload) }];
}

export function syntheticSpanModelRequestEndDrafts(
  startEventIds: readonly string[],
): EventDraft[] {
  return startEventIds.map((startEventId) => ({
    type: "span.model_request_end",
    payload: toJsonObject({
      model_request_start_id: startEventId,
      is_error: true,
      model_usage: zeroModelUsage,
    }),
  }));
}

function assistantMessage(input: unknown): JsonObject | undefined {
  if (!isObject(input) || !isObject(input.message)) return undefined;
  return input.message.role === "assistant" ? input.message : undefined;
}

function eventType(input: unknown): string {
  return isObject(input) && typeof input.type === "string" ? input.type : "";
}

function hasModelRequestMetadata(message: JsonObject): boolean {
  return (
    typeof message.api === "string" &&
    typeof message.provider === "string" &&
    typeof message.model === "string"
  );
}

function usageFromMessage(message: JsonObject): ManagedAgentsSpanModelUsage {
  if (!isObject(message.usage)) return zeroModelUsage;
  return {
    cache_creation_input_tokens: numberField(message.usage.cacheWrite),
    cache_read_input_tokens: numberField(message.usage.cacheRead),
    input_tokens: numberField(message.usage.input),
    output_tokens: numberField(message.usage.output),
  };
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toJsonObject(value: ManagedAgentsSpanModelRequestEndPayload): JsonObject {
  return value as unknown as JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
