// SecretsStore contract (plan 0118, ADR 0016 §4). Deliberately small — it
// grows only when 0117c (credential injection) pulls on it.

export interface SecretMetadata {
  id: string;
  workspace_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface SecretsStore {
  /** Upsert. Always seals under a fresh DEK; an existing name keeps its id. */
  put(workspaceId: string, name: string, value: string): SecretMetadata;
  /**
   * Returns the PLAINTEXT secret. Named `reveal` (not `get`) so every call
   * site is loud and greppable — only the egress injection boundary (0117c)
   * should call this.
   */
  reveal(workspaceId: string, name: string): string | undefined;
  /** Metadata only — never carries plaintext. */
  list(workspaceId: string): SecretMetadata[];
  delete(workspaceId: string, name: string): boolean;
  /**
   * Rewraps every row's DEK under the new key (ciphertext untouched) and
   * switches the store to it. Returns the number of rows rewrapped. Limits
   * blast radius going forward; it is not revocation (ADR 0016 §4).
   */
  rotateMasterKey(newMasterKey: Buffer): number;
  close(): void;
}
