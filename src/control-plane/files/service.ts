import { invalidRequest, notFound } from "../errors.ts";
import type {
  FileListOptions,
  FileService,
  FileStorage,
  ManagedAgentsDeletedFile,
  ManagedAgentsFileListPage,
  ManagedAgentsFileMetadata,
  UploadedFileInput,
  WorkspaceId,
} from "./types.ts";

export class DefaultFileService implements FileService {
  constructor(private readonly storage: FileStorage) {}

  async upload(
    workspaceId: WorkspaceId,
    input: UploadedFileInput,
  ): Promise<ManagedAgentsFileMetadata> {
    const record = await this.storage.create(workspaceId, {
      filename: normalizeFilename(input.filename),
      mimeType: normalizeMimeType(input.mimeType),
      body: input.body,
    });
    return record.metadata;
  }

  async retrieveMetadata(
    workspaceId: WorkspaceId,
    fileId: string,
  ): Promise<ManagedAgentsFileMetadata> {
    const record = await this.storage.retrieveMetadata(workspaceId, fileId);
    if (!record) {
      throw notFound(`File ${fileId} not found`);
    }
    return record.metadata;
  }

  async download(workspaceId: WorkspaceId, fileId: string): Promise<never> {
    await this.retrieveMetadata(workspaceId, fileId);
    throw invalidRequest(`File '${fileId}' is not downloadable`);
  }

  async delete(
    workspaceId: WorkspaceId,
    fileId: string,
  ): Promise<ManagedAgentsDeletedFile> {
    const deleted = await this.storage.delete(workspaceId, fileId);
    if (!deleted) {
      throw notFound(`File ${fileId} not found`);
    }
    return { id: fileId, type: "file_deleted" };
  }

  async list(
    workspaceId: WorkspaceId,
    opts: FileListOptions = {},
  ): Promise<ManagedAgentsFileListPage> {
    if (!this.storage.list) {
      return {
        data: [],
        has_more: false,
        first_id: null,
        last_id: null,
      };
    }
    const page = await this.storage.list(workspaceId, opts);
    return {
      data: page.data.map((record) => record.metadata),
      has_more: page.has_more,
      first_id: page.first_id,
      last_id: page.last_id,
    };
  }
}

function normalizeFilename(filename: string): string {
  const trimmed = filename.trim();
  if (trimmed.length === 0) {
    throw invalidRequest("Uploaded file must include a filename");
  }
  return trimmed;
}

function normalizeMimeType(mimeType: string): string {
  const trimmed = mimeType.trim();
  return trimmed.length === 0 ? "application/octet-stream" : trimmed;
}
