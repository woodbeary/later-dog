export function signPreviousBackup(bootstrap: string, descriptor: unknown): Promise<string>;
export function verifyPreviousBackupSignature(bootstrap: string, descriptor: unknown): Promise<boolean>;
export function derivePreviousBackupKey(bootstrap: string): Promise<Uint8Array>;
export function verifyPreviousBackupSignatureWithKey(key: Uint8Array, descriptor: unknown): Promise<boolean>;
