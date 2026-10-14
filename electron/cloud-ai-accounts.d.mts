export type AiAccountKind = "claude" | "codex";
export interface KeychainItem { service: string; account: string }
export type MacAccountSource =
  | { instanceId: string; kind: AiAccountKind; displayName: string; held: boolean; file: string; keychain?: KeychainItem }
  | { instanceId: string; kind: "chatgpt-plan"; displayName: string };
export interface AccountRecord { kind: AiAccountKind; name: string; source: "keychain" | "file"; at: number }
export interface AccountRecords { origin: string | null; accounts: Record<string, AccountRecord> }
export interface AccountsSummary {
  moved: { claude: number; chatgpt: number };
  stayed: Array<{ name: string; why: "home" | "unreadable" | "chatgpt-plan" }>;
  waiting: string[];
}
export interface AccountsReturned { returned: string[]; stayed: string[] }
export interface MacKeychain {
  has(item: KeychainItem): Promise<boolean>;
  read(item: KeychainItem): Promise<string | null>;
  write(item: KeychainItem, text: string): Promise<void>;
}
export interface AccountsDestination { origin: string; grant(): Promise<{ origin: string; code: string }> }

export declare const MAC_ACCOUNT_ROUTES: RegExp;
export declare function decodeKeychainText(text: string): string;
export declare function claudeStoreFrom(text: string): { root: Record<string, unknown>; login: Record<string, unknown> | null } | null;
export declare function codexStoreFrom(text: string): { root: Record<string, unknown>; login: Record<string, unknown> | null } | null;
export declare function refreshTokenOf(kind: AiAccountKind, login: Record<string, unknown>): string;
export declare function loginFingerprint(refreshToken: string): string;
export declare function parseMacAccountSource(value: unknown): MacAccountSource | null;
export declare function parseAccountRecords(raw: unknown): AccountRecords;
export declare function serializeAccountRecords(records: AccountRecords): string;
export declare function homeOriginAllowed(origin: unknown): boolean;
export declare function readSecretFile(path: string): Promise<string | null>;
export declare function writeSecretFile(path: string, text: string): Promise<void>;
export declare function createMacKeychain(options?: {
  execFile?: typeof import("node:child_process").execFile;
  spawn?: typeof import("node:child_process").spawn;
  timeoutMs?: number;
}): MacKeychain;
export interface CloudAiAccounts {
  records(): AccountRecords;
  ensure(destination: AccountsDestination | null | undefined): Promise<AccountsSummary | null>;
  bringBack(destination: AccountsDestination): Promise<AccountsReturned>;
  stop(): void;
  close(): void;
}
export declare function createCloudAiAccounts(options: {
  localRequest(route: string, init: RequestInit): Promise<Response>;
  fetchImpl?: typeof fetch;
  keychain?: MacKeychain | null;
  readFile?: (path: string) => Promise<string | null>;
  writeFile?: (path: string, text: string) => Promise<void>;
  read(): unknown;
  write(contents: string): void;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  retryDelaysMs?: readonly number[];
  onChange?: (summary: AccountsSummary) => void;
  log?: (message: string) => void;
}): CloudAiAccounts;
