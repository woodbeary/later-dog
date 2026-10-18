export interface CloudAccountState {
  status: "signed-out" | "connecting" | "connected" | "reauth-required" | "unavailable";
  message?: string;
  enrollment?: { userCode: string; expiresAt: number };
  account?: { id: string; email: string };
  deviceId?: string;
  expiresAt?: number;
  entitlement?: { plan: "free" | "pro"; tier?: string; status: "active" | "inactive"; expiresAt: number | null; version: number };
  verifiedAt?: number;
  verifiedUntil?: number;
  checking?: true;
  lastPlan?: { tier?: string; active: boolean };
  machine?: import("./cloud-home.mjs").CloudMachine;
  purchase?: import("./cloud-home.mjs").CloudPurchase;
}
export type CloudSignInFailure = import("./cloud-sign-in.mjs").CloudSignInFailure;
export type CloudSendCodeResult = { ok: true; email: string } | { ok: false; code: CloudSignInFailure };
export type CloudVerifyCodeResult = { ok: true; account: CloudAccountState } | { ok: false; code: CloudSignInFailure };
export interface CloudAccountBridge {
  state(): Promise<CloudAccountState>;
  begin(): Promise<CloudAccountState>;
  signInAgain(): Promise<CloudAccountState>;
  reopen(): Promise<CloudAccountState>;
  cancel(): Promise<CloudAccountState>;
  refresh(): Promise<CloudAccountState>;
  signOut(): Promise<CloudAccountState>;
  openDashboard(): Promise<CloudAccountState>;
  connectHome(): Promise<CloudAccountState>;
  connectHomeForPhone(): Promise<CloudAccountState>;
  sendCode(email: string): Promise<CloudSendCodeResult>;
  verifyCode(email: string, code: string): Promise<CloudVerifyCodeResult>;
  offer(): Promise<{ due: boolean }>;
  declineOffer(): Promise<{ due: boolean }>;
  onState(callback: (state: CloudAccountState) => void): () => void;
  lending?: import("./computer-sharing.mjs").CloudLendingBridge;
}
export interface CloudPlanSnapshot { status: "paid" | "attention" | "checking" | "signin" | "none"; tier?: string }
export interface CloudPlanBridge {
  state(): Promise<CloudPlanSnapshot>;
  manage(): Promise<void>;
  signOut(): Promise<void>;
}

export declare const CLOUD_ORIGIN: string;
export declare const DEFAULT_CLOUD_ORIGIN: string;
export declare function configuredCloudOrigin(environment?: NodeJS.ProcessEnv): string;
export declare function cloudOrigin(value?: string, fixture?: boolean): string;
export interface CloudAccountStore {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}
export declare function createCloudAccountStore(options: {
  file: string;
  encryption: {
    available(): boolean | Promise<boolean>;
    encrypt(value: string): Buffer | Promise<Buffer>;
    decrypt(value: Buffer): string | { result: string } | Promise<string | { result: string }>;
  };
}): CloudAccountStore;
export interface CloudDeviceGrant {
  cloudContractVersion: 1;
  accessToken: string;
  expiresAt: number;
  device: { id: string };
  account: { id: string; email: string };
}
export interface CloudAccountClient {
  state(): CloudAccountState;
  start(): Promise<CloudAccountState>;
  begin(): Promise<CloudAccountState>;
  adopt(result: CloudDeviceGrant): Promise<CloudAccountState>;
  signInAgain(): Promise<CloudAccountState>;
  reopen(): Promise<CloudAccountState>;
  cancel(): Promise<CloudAccountState>;
  refresh(): Promise<CloudAccountState>;
  signOut(): Promise<CloudAccountState>;
  openDashboard(): Promise<CloudAccountState>;
  homeTarget(): { origin: string } | null;
  pairHome(): Promise<import("./cloud-home.mjs").CloudHomeGrant>;
  growDisk(sizeGb: number): Promise<{ supported: false } | { supported: true; refused: true } | { supported: true; disk: { gb: number; maxGb: number } }>;
  close(): void;
}
export declare function createCloudAccountClient(options: {
  store: CloudAccountStore;
  openBrowser(url: string): Promise<unknown>;
  platform: string;
  deviceName: string;
  appVersion?: string;
  origin?: string;
  fixture?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  onState?: (state: CloudAccountState) => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  warn?: (message: string) => void;
}): CloudAccountClient;
export declare function cloudPlanSnapshot(state: CloudAccountState | null | undefined): CloudPlanSnapshot;
