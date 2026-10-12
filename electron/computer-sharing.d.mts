export interface SharedFolder { id: string; name: string; path: string; write: boolean }
export interface SharingState {
  enabled: boolean;
  folders: SharedFolder[];
  terminal: boolean;
  computer: boolean;
  connected?: boolean;
  error?: string;
}
interface Workspace { id: string; name: string; origin: string }
interface Identity { sessionId: string; environmentId: string }
export interface LendingActivityEntry {
  at: number;
  server: string;
  origin: string;
  action: string;
  detail: string;
  ok: boolean;
  error?: string;
}
export interface CloudLendingState {
  enabled: boolean;
  folders: SharedFolder[];
  screen: boolean;
  busy: boolean;
  connected?: boolean;
  problem?: "connect-first" | "not-cloud" | "waiting" | "paused" | "signed-out" | "account-changed" | "machine-changed";
  error?: string;
}
export interface CloudLendingSnapshot {
  available: boolean;
  screenAvailable: boolean;
  state?: CloudLendingState;
  activity?: LendingActivityEntry[];
}
export interface CloudLendingBridge {
  state(): Promise<CloudLendingSnapshot>;
  chooseFolder(): Promise<SharedFolder | null>;
  save(input: { folders: SharedFolder[]; screen: boolean }): Promise<CloudLendingSnapshot>;
  stop(): Promise<CloudLendingSnapshot>;
}
export type CloudLendingVerdict = { allow: true } | { pause: string } | { stop: "signed-out" | "account-changed" | "machine-changed" };
export function cloudLendingVerdict(binding: { accountId: string; origin: string } | null | undefined, current: { status: string; accountId: string | null; origin: string | null } | null, env: { origin: string } | null | undefined): CloudLendingVerdict;
export function validateSharedFolders(folders: unknown): Promise<SharedFolder[]>;
export function validSharedOperation(operation: unknown, computerId: string): boolean;
export function createComputerSharing(options: {
  file: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  environments: () => Workspace[];
  enabled?: () => Promise<boolean>;
  protectedPaths?: string[];
  cuaConnection: () => Promise<{ mcpCommand: string; mcpArgs: string[]; mcpEnv?: Record<string, string> } | null>;
  hostControl?: (id: string, signal: AbortSignal) => Promise<{ renew(): Promise<unknown>; release(): Promise<unknown> }>;
  home?: string;
  activityFile?: string;
  cloud?: () => { status: string; accountId: string | null; origin: string | null } | null;
  onChange?: (summary: { lending: string[]; busy: { env: string; action: string } | null }) => void;
}): {
  state(id: string): SharingState;
  activity(id?: string, limit?: number): LendingActivityEntry[];
  identity(env: Workspace): Promise<Identity>;
  observe(env: Workspace): Promise<Identity | null>;
  decline(env: Workspace, identity: Identity): void;
  save(env: Workspace, input: Pick<SharingState, "folders" | "terminal" | "computer">, identity: Identity): Promise<SharingState>;
  revoke(env: Workspace): SharingState;
  forget(env: Workspace): void;
  cloudState(env: Workspace | null | undefined): CloudLendingState;
  saveCloud(env: Workspace, input: { folders: unknown; screen?: boolean }): Promise<CloudLendingState>;
  cloudChanged(): void;
  start(options?: { maintainer?: boolean }): void;
  close(): void;
};
