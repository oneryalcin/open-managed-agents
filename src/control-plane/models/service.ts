import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { invalidRequest } from "../errors.ts";
import type { WorkspaceId } from "../workspace.ts";
import type { PiModelCatalog, PiResolvedModel } from "./catalog.ts";

export interface ManagedAgentsModelCatalogEntry {
  type: "model";
  provider: string;
  id: string;
  name: string;
  provider_name: string;
  reasoning: boolean;
  input: string[];
  context_window: number;
  max_output_tokens: number;
  credentials_configured: boolean;
  default: boolean;
}

export interface ManagedAgentsModelCatalogPage {
  data: ManagedAgentsModelCatalogEntry[];
  next_page: string | null;
}

export interface ListModelCatalogOptions {
  provider?: string;
  available?: boolean;
  limit?: number;
  page?: string;
}

export interface ModelCatalogService {
  list(
    workspaceId: WorkspaceId,
    opts?: ListModelCatalogOptions,
  ): ManagedAgentsModelCatalogPage;
}

interface ModelCatalogCursorPayload {
  v: 1;
  provider: string | null;
  available: boolean;
  anchor: {
    provider: string;
    id: string;
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export class DefaultModelCatalogService implements ModelCatalogService {
  private readonly cursorSigningKey = randomBytes(32);

  constructor(private readonly catalog: PiModelCatalog) {}

  list(
    workspaceId: WorkspaceId,
    opts: ListModelCatalogOptions = {},
  ): ManagedAgentsModelCatalogPage {
    const context = {
      provider: opts.provider ?? null,
      available: opts.available ?? false,
    };
    const limit = normalizeLimit(opts.limit);
    const anchor = opts.page === undefined
      ? undefined
      : decodeCursor(opts.page, workspaceId, context, this.cursorSigningKey).anchor;
    const models = this.catalog
      .list({
        ...(context.provider === null ? {} : { provider: context.provider }),
        availableOnly: context.available,
      })
      .slice()
      .sort(compareModelRefs);
    const startIndex = anchor === undefined
      ? 0
      : models.findIndex((model) => compareModelRefParts(model.provider, model.id, anchor.provider, anchor.id) > 0);
    const pageModels = models.slice(startIndex < 0 ? models.length : startIndex, (startIndex < 0 ? models.length : startIndex) + limit + 1);
    const dataModels = pageModels.slice(0, limit);
    const next = pageModels.length > limit ? dataModels.at(-1) : undefined;
    return {
      data: dataModels.map((model) => this.toEntry(model)),
      next_page: next === undefined
        ? null
        : encodeCursor(
            {
              v: 1,
              provider: context.provider,
              available: context.available,
              anchor: { provider: next.provider, id: next.id },
            },
            workspaceId,
            this.cursorSigningKey,
          ),
    };
  }

  private toEntry(model: PiResolvedModel): ManagedAgentsModelCatalogEntry {
    return {
      type: "model",
      provider: model.provider,
      id: model.id,
      name: model.name,
      provider_name: this.catalog.modelRegistry.getProviderDisplayName(model.provider),
      reasoning: model.reasoning,
      input: [...model.input],
      context_window: model.contextWindow,
      max_output_tokens: model.maxTokens,
      credentials_configured: this.catalog.hasConfiguredAuth(model),
      default:
        model.provider === this.catalog.defaultModel.provider &&
        model.id === this.catalog.defaultModel.id,
    };
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw invalidRequest("`limit` must be an integer from 1 through 100");
  }
  return limit;
}

function compareModelRefs(left: PiResolvedModel, right: PiResolvedModel): number {
  return compareModelRefParts(left.provider, left.id, right.provider, right.id);
}

function compareModelRefParts(
  leftProvider: string,
  leftId: string,
  rightProvider: string,
  rightId: string,
): number {
  if (leftProvider !== rightProvider) return leftProvider < rightProvider ? -1 : 1;
  if (leftId === rightId) return 0;
  return leftId < rightId ? -1 : 1;
}

function encodeCursor(
  payload: ModelCatalogCursorPayload,
  workspaceId: string,
  signingKey: Buffer,
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signCursor(encodedPayload, workspaceId, signingKey);
  return `${encodedPayload}.${signature.toString("base64url")}`;
}

function decodeCursor(
  value: string,
  workspaceId: string,
  context: { provider: string | null; available: boolean },
  signingKey: Buffer,
): ModelCatalogCursorPayload {
  let payload: unknown;
  try {
    const parts = value.split(".");
    if (parts.length !== 2) throw new Error("invalid cursor");
    const [encodedPayload, encodedSignature] = parts as [string, string];
    const decoded = decodeCanonicalBase64url(encodedPayload);
    const signature = decodeCanonicalBase64url(encodedSignature);
    const expected = signCursor(encodedPayload, workspaceId, signingKey);
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
      throw new Error("invalid signature");
    }
    payload = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw invalidRequest("invalid page cursor");
  }
  if (!isCursorPayload(payload)) throw invalidRequest("invalid page cursor");
  if (payload.provider !== context.provider || payload.available !== context.available) {
    throw invalidRequest("page token filters do not match request");
  }
  return payload;
}

function signCursor(
  encodedPayload: string,
  workspaceId: string,
  signingKey: Buffer,
): Buffer {
  return createHmac("sha256", signingKey)
    .update("oma-model-catalog-page-v1\0", "utf8")
    .update(workspaceId, "utf8")
    .update("\0", "utf8")
    .update(encodedPayload, "utf8")
    .digest();
}

function decodeCanonicalBase64url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("invalid base64url");
  return decoded;
}

function isCursorPayload(value: unknown): value is ModelCatalogCursorPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const anchor = record.anchor as Record<string, unknown> | undefined;
  return (
    record.v === 1 &&
    (record.provider === null || typeof record.provider === "string") &&
    typeof record.available === "boolean" &&
    typeof anchor === "object" &&
    anchor !== null &&
    typeof anchor.provider === "string" &&
    typeof anchor.id === "string"
  );
}
