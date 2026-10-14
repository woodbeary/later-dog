export type CredentialDocument = Record<string, unknown>;

export interface SecureCredentialState {
  read(): CredentialDocument;
  retry(): Promise<boolean>;
  update(
    derive: (current: CredentialDocument) => CredentialDocument,
    afterPersist?: (next: CredentialDocument) => Promise<void> | void,
  ): Promise<unknown>;
}

export declare function createSecureCredentialState(
  initialCredentials: CredentialDocument,
  persist: (next: CredentialDocument) => Promise<void> | void,
  options?: {
    writable?: boolean;
    reload?: () => Promise<{ status: string; credentials: CredentialDocument }>;
    afterReload?: (credentials: CredentialDocument) => Promise<void> | void;
  },
): SecureCredentialState;
