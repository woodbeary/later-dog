export type CredentialDocument = Record<string, unknown>;

export interface SecureCredentialState {
  read(): CredentialDocument;
  update(
    derive: (current: CredentialDocument) => CredentialDocument,
    afterPersist?: (next: CredentialDocument) => Promise<void> | void,
  ): Promise<unknown>;
}

export declare function createSecureCredentialState(
  initialCredentials: CredentialDocument,
  persist: (next: CredentialDocument) => Promise<void> | void,
  options?: { writable?: boolean },
): SecureCredentialState;
