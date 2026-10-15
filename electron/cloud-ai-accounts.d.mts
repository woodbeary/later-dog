export type AiAccountKind = "claude" | "codex";
export interface KeychainItem { service: string; account: string }
export type MacAccountSource =
  | { instanceId: string; kind: AiAccountKind; displayName: string; held: boolean; file: string; keychain?: KeychainItem; email?: string }
  | { instanceId: string; kind: "chatgpt-plan"; displayName: string };
export interface AccountRecord { kind: AiAccountKind; name: string; source: "keychain" | "file"; origin: string | null; at: number }
export type KeptRefusal = "home_signed_in" | "different_account" | "other_device" | "not_signed_in";
export interface RefusalRecord { code: KeptRefusal; origin: string; fingerprint: string | null; at: number }
export interface AccountRecords { origin: string | null; deviceId: string | null; accounts: Record<string, AccountRecord>; refused: Record<string, RefusalRecord> }
export interface AccountsSummary {
  moved: { claude: number; chatgpt: number };
  stayed: Array<{ name: string; why: "home" | "unreadable" | "refused" | "elsewhere" | "chatgpt-plan" }>;
  waiting: string[];
}
export interface MacKeychain {
  has(item: KeychainItem): Promise<boolean>;
  read(item: KeychainItem): Promise<string | null>;
}
export interface HandAccountsRequest { homeOrigin: string; session: () => Promise<{ origin: string; code: string }> }

export declare const MAC_ACCOUNT_ROUTES: RegExp;
export declare const FINAL_REFUSALS: readonly KeptRefusal[];
export declare const REFUSALS_KEPT: readonly KeptRefusal[];
export declare function decodeKeychainText(text: string): string;
export declare function claudeStoreFrom(text: string): { root: Record<string, unknown>; login: Record<string, unknown> | null } | null;
export declare function codexStoreFrom(text: string): { root: Record<string, unknown>; login: Record<string, unknown> | null } | null;
export declare function refreshTokenOf(kind: AiAccountKind, login: Record<string, unknown>): string;
export declare function loginFingerprint(refreshToken: string): string;
export declare function parseMacAccountSource(value: unknown): MacAccountSource | null;
export declare function parseAccountRecords(raw: unknown): AccountRecords;
export declare function serializeAccountRecords(records: Omit<AccountRecords, "refused"> & { refused?: AccountRecords["refused"] }): string;
export declare function homeOriginAllowed(origin: unknown): boolean;
export declare function readSecretFile(path: string): Promise<string | null>;
export declare function createMacKeychain(options?: {
  execFile?: typeof import("node:child_process").execFile;
  timeoutMs?: number;
}): MacKeychain;
export interface CloudAiAccounts {
  records(): AccountRecords;
  handAccountsToCloud(request: HandAccountsRequest): Promise<AccountsSummary | null>;
  stop(): void;
  close(): void;
}
export declare function createCloudAiAccounts(options: {
  localRequest(route: string, init: RequestInit): Promise<Response>;
  fetchImpl?: typeof fetch;
  keychain?: MacKeychain | null;
  readFile?: (path: string) => Promise<string | null>;
  read(): unknown;
  write(contents: string): void;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  retryDelaysMs?: readonly number[];
  onChange?: (summary: AccountsSummary) => void;
  log?: (message: string) => void;
}): CloudAiAccounts;
