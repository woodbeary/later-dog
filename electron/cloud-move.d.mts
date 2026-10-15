export interface MoveContents { bots: number; rooms: number; chats: number }
export interface ServerIdentity { appVersion: string | null; environmentId: string | null }
export interface MoveEstimate extends MoveContents, Partial<ServerIdentity> { bytes: number; files: number; routines?: number }
export interface MoveDestination { id: string | null; name: string; origin: string | null; kind: "cloud" | "server" }
export interface MoveTarget extends MoveDestination {
  grant(): Promise<{ origin: string; code: string; expiresAt?: number }>;
  disk?: () => import("./cloud-home.mjs").CloudPlanDisk | null;
  grow?: (sizeGb: number) => Promise<{ supported: boolean; refused?: boolean }>;
}
export type MoveBlocked = "owner_needed" | "shared_workspace" | "same_computer" | "outdated" | "unreachable" | "busy_elsewhere";
export interface CloudMoveStatus extends ServerIdentity {
  contents: MoveContents;
  empty: boolean;
  freeBytes: number;
  volumeBytes: number | null;
  previous: (MoveContents & { createdAt: string; bytes?: number }) | null;
  uploadReceived: number;
  heldBytes: number | null;
  pendingRestore: boolean;
  busy: boolean;
  job: Record<string, unknown> | null;
  lastRestoreId: string | null;
  rolledBackId: string | null;
  partBytes: number;
  receivedFrom: { at: number; environmentId: string | null } | null;
}
export type CloudMovePhase = "idle" | "preparing" | "growing" | "exporting" | "uploading" | "checking" | "replacing" | "restarting" | "done" | "failed";
export interface CloudMoveState {
  phase: CloudMovePhase;
  action?: "move" | "restore";
  destination?: MoveDestination | null;
  progress?: { bytesTransferred: number; totalBytes: number };
  replacing?: boolean;
  error?: { code: string; message: string; contents?: MoveContents; freeBytes?: number; neededBytes?: number; maxBytes?: number; largest?: true; volumeBytes?: number; destVersion?: string; localVersion?: string;
    other?: string;
    partBytes?: number };
  resumable?: boolean;
  moved?: MoveContents;
  previous?: boolean;
  routines?: number;
  stayedOnMac?: Array<{ name: string; bytes: number }>;
  accounts?: AccountsNote;
}
export interface AccountsNote { moved: { claude: number; chatgpt: number }; stayed: string[] }
export interface MoveFit { fit: "now" | "grow" | "never"; neededBytes: number; freeBytes: number; maxBytes?: number; largest?: true; volumeBytes?: number; sizeGb?: number }
export interface CloudMoveOverview extends CloudMoveState {
  local: MoveEstimate | null;
  cloud: (Pick<CloudMoveStatus, "contents" | "empty" | "freeBytes" | "previous" | "heldBytes"> & Partial<Pick<CloudMoveStatus, "appVersion">>) | null;
  fit?: MoveFit | null;
  suggest: boolean;
  automatic?: true;
  destination?: MoveDestination | null;
  blocked?: MoveBlocked | null;
  busyWith?: string;
}
export interface CloudMoveBridge {
  state(id?: string): Promise<CloudMoveOverview>;
  start(id?: string): Promise<CloudMoveState>;
  cancel(): Promise<CloudMoveState>;
  restorePrevious(id?: string): Promise<CloudMoveState>;
  dismiss(id?: string): Promise<CloudMoveOverview>;
  onState(callback: (state: CloudMoveState) => void): () => void;
}

export declare const CLOUD_MOVE_MAX_BYTES: number;
export declare const CLOUD_MOVE_PROFILE: "cloud-move";
export declare const CLOUD_MOVE_LOCAL_ROUTES: RegExp;
export declare class CloudMoveError extends Error {
  code: string;
  details: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>);
}
export declare function cloudPageSenderAllowed(event: unknown, context: { contents: unknown; homeOrigin: string | null | undefined; activeOrigin: string | null | undefined }): boolean;
export declare function moveSenderDestination(event: unknown, context: {
  contents: unknown; environments: { environments: Array<{ id: string; name: string; origin: string }>; activeId: string };
  localOrigin: string | null | undefined; cloudHomeOrigin?: string | null; id?: unknown;
}): { entry: { id: string; name: string; origin: string | null; cloud?: true } | null; remote: boolean } | null;
export declare function moveRefusal(status: number, body: unknown): MoveBlocked;
export declare function olderVersion(a: unknown, b: unknown): boolean;
export declare function moveBlocked(input: { kind: "cloud" | "server"; refusal?: MoveBlocked | null; local?: Partial<ServerIdentity> | null; cloud?: Partial<ServerIdentity> | null; busyElsewhere?: boolean }): MoveBlocked | null;
export declare function mintOwnerCode(fetchImpl: typeof fetch, origin: string, options?: { label?: string; timeoutMs?: number }): Promise<{ origin: string; code: string; expiresAt: number }>;
export declare function parseMoveEstimate(value: unknown): MoveEstimate | null;
export declare function moveFit(input: { localBytes: number; freeBytes: number; uploadReceived?: number; volumeBytes?: number | null; disk?: import("./cloud-home.mjs").CloudPlanDisk | null }): MoveFit;
export declare function arrivedInFull(local: MoveContents | null | undefined, contents: MoveContents | null | undefined): boolean;
export declare function parseCloudMoveStatus(value: unknown): CloudMoveStatus | null;
export interface CloudMove {
  state(): CloudMoveState;
  estimate(signal?: AbortSignal, profile?: "cloud-move"): Promise<MoveEstimate>;
  move(dest: MoveTarget, options?: { requireEmpty?: boolean; verifyArrival?: boolean; profile?: "cloud-move"; yieldToOtherComputer?: boolean }): Promise<CloudMoveState>;
  restorePrevious(dest: MoveTarget): Promise<CloudMoveState>;
  cancel(): CloudMoveState;
  reset(): CloudMoveState;
  running(): boolean;
  close(): Promise<void>;
}
export declare function createCloudMove(options: {
  localRequest(route: string, init: RequestInit): Promise<Response>;
  fetchImpl?: typeof fetch;
  tempRoot: string;
  availableBytes(path: string): Promise<number>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onState?: (state: CloudMoveState) => void;
  log?: (line: string) => void;
  waitDelaysMs?: number[];
  retryDelaysMs?: number[];
  pollMs?: number;
  restartTimeoutMs?: number;
  jobTimeoutMs?: number;
  growTimeoutMs?: number;
}): CloudMove;
