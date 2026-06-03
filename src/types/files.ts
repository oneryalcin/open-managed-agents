export interface ManagedAgentsFileSessionScope {
  type: "session";
  id: string;
}

export type ManagedAgentsFileScope = ManagedAgentsFileSessionScope | null;

export interface ManagedAgentsFileMetadata {
  id: string;
  type: "file";
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  downloadable: boolean;
  scope: ManagedAgentsFileScope;
}

export interface ManagedAgentsDeletedFile {
  id: string;
  type: "file_deleted";
}

export interface ManagedAgentsFileListPage {
  data: ManagedAgentsFileMetadata[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}
