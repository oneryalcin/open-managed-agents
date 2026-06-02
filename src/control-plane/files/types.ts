import type {
  ManagedAgentsDeletedFile,
  ManagedAgentsFileListPage,
  ManagedAgentsFileMetadata,
} from "../../types/files.ts";
import type { WorkspaceId } from "../workspace.ts";

export { DEFAULT_WORKSPACE_ID, type WorkspaceId } from "../workspace.ts";
export type {
  ManagedAgentsDeletedFile,
  ManagedAgentsFileListPage,
  ManagedAgentsFileMetadata,
};

export const MAX_UPLOADED_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_WORKSPACE_FILE_BYTES = 100 * 1024 * 1024;

export interface UploadedFileInput {
  filename: string;
  mimeType: string;
  body: AsyncIterable<Uint8Array> | Uint8Array;
}

export interface InternalFileSnapshotInput extends UploadedFileInput {
  scopeId: string;
}

export interface FileStorageRecord {
  metadata: ManagedAgentsFileMetadata;
  workspace_id: WorkspaceId;
  storage_key: string;
  sha256: string;
}

export interface StoredFile extends FileStorageRecord {
  bytes: Uint8Array;
  visibility: "public" | "internal";
}

export interface FileListOptions {
  afterId?: string;
  beforeId?: string;
  limit?: number;
  scopeId?: string;
}

export interface FileStoragePage {
  data: FileStorageRecord[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

export interface FileStorage {
  /**
   * Creates must be atomic with respect to quota accounting: either metadata,
   * bytes, and workspace byte totals are all committed, or none are. Persistent
   * backends must not split quota check/write/accounting across unsafe awaits.
   */
  create(
    workspaceId: WorkspaceId,
    input: UploadedFileInput,
  ): Promise<FileStorageRecord>;
  retrieveMetadata(
    workspaceId: WorkspaceId,
    fileId: string,
  ): Promise<FileStorageRecord | undefined>;
  openBytes(
    workspaceId: WorkspaceId,
    fileId: string,
  ): Promise<AsyncIterable<Uint8Array> | undefined>;
  createInternalSnapshot(
    workspaceId: WorkspaceId,
    input: InternalFileSnapshotInput,
  ): Promise<FileStorageRecord>;
  openInternalSnapshotBytes(
    workspaceId: WorkspaceId,
    fileId: string,
  ): Promise<AsyncIterable<Uint8Array> | undefined>;
  /**
   * Returns true when an internal snapshot was deleted. Returns false only when
   * the snapshot is already absent for this workspace. Durable backends must
   * throw for retryable I/O, authorization, or consistency failures.
   */
  deleteInternalSnapshot(
    workspaceId: WorkspaceId,
    fileId: string,
  ): Promise<boolean>;
  delete(workspaceId: WorkspaceId, fileId: string): Promise<boolean>;
  list(
    workspaceId: WorkspaceId,
    opts?: FileListOptions,
  ): Promise<FileStoragePage>;
}

export interface FileService {
  upload(
    workspaceId: WorkspaceId,
    input: UploadedFileInput,
  ): Promise<ManagedAgentsFileMetadata>;
  retrieveMetadata(
    workspaceId: WorkspaceId,
    fileId: string,
  ): Promise<ManagedAgentsFileMetadata>;
  download(workspaceId: WorkspaceId, fileId: string): Promise<never>;
  delete(
    workspaceId: WorkspaceId,
    fileId: string,
  ): Promise<ManagedAgentsDeletedFile>;
  list(
    workspaceId: WorkspaceId,
    opts?: FileListOptions,
  ): Promise<ManagedAgentsFileListPage>;
}
