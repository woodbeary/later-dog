import type { CloudDeviceGrant } from "./cloud-account.mjs";

export declare const CLOUD_CODE_LENGTH: number;
export type CloudSignInFailure = "invalid_email" | "wrong_code" | "expired_code" | "rate_limited" | "email_unavailable" | "network" | "unavailable";
export declare class CloudSignInError extends Error {
  code: CloudSignInFailure;
  constructor(code: CloudSignInFailure);
}
export declare function normalizeEmail(value: unknown): string | null;
export declare function normalizeCode(value: unknown): string | null;
export interface CloudSignIn {
  sendCode(email: unknown): Promise<string>;
  verifyCode(email: unknown, code: unknown): Promise<CloudDeviceGrant>;
}
export declare function createCloudSignIn(options: {
  origin: string;
  fetch?: typeof fetch;
  deviceName: string;
  platform: string;
  appVersion?: string;
}): CloudSignIn;
