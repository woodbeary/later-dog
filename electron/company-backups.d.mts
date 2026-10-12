import type { Readable } from "node:stream";
import type { WorkspaceBackupClientState, WorkspaceBackupSummary } from "../shared/workspace-backup.ts";

export interface CompanyBackupProgress {
  phase: "exporting" | "reading" | "uploading" | "completing" | "downloading" | "validating" | "preparing" | "ready";
  bytesTransferred: number;
  totalBytes: number;
}
export interface CompanyBackupMetadata {
  passwordRequired: boolean;
  id: string; status: "ready"; sizeBytes: number; sha256: string;
  appVersion?: string; createdAt?: number; completedAt?: number;
}
export interface CompanyBackupRequestInit extends Omit<RequestInit, "body"> {
  body?: BodyInit | Readable;
  duplex?: "half";
}
export interface CompanyBackupTransferOptions {
  localRequest: (path: string, init: CompanyBackupRequestInit) => Promise<Response>;
  portalRequest: (path: string, init: { method: string; body?: unknown; signal?: AbortSignal }) => Promise<unknown>;
  tempRoot: string;
  fetchImpl?: (url: string, init: CompanyBackupRequestInit) => Promise<Response>;
  allowLoopbackForTests?: boolean;
  availableBytes?: (path: string) => Promise<number>;
}
export class CompanyBackupError extends Error { code: string; constructor(code: string, message: string); }
export function createCompanyBackups(options: CompanyBackupTransferOptions): {
  backup(input: { clientState?: WorkspaceBackupClientState; appVersion?: string }, signal?: AbortSignal, onProgress?: (progress: CompanyBackupProgress) => void): Promise<CompanyBackupMetadata>;
  prepareRestore(input: { id: string; password?: string }, signal?: AbortSignal, onProgress?: (progress: CompanyBackupProgress) => void): Promise<{ id: string; summary: WorkspaceBackupSummary }>;
};
