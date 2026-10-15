import { base64url, hmacSha256, randomToken } from "./encoding.ts";

export const HOME_ACTIVITY_PATH = "/api/cloud/activity";
export const WAKE_EARLY_MS = 60_000;
export const MIN_WAKE_DELAY_MS = 60_000;

const WORK_NAME = /^[a-z_]{1,32}$/;
const MAX_WORK_NAMES = 10;

export interface HomeActivity {
  busy: boolean;
  nextAt: number | null;
  work: string[];
}

export async function activitySignature(secret: string, timestamp: string, nonce: string): Promise<string> {
  return base64url(await hmacSha256(secret, `v1\n${timestamp}\n${nonce}\nGET\n${HOME_ACTIVITY_PATH}`));
}

export async function signedActivityRequest(origin: string, secret: string, now = Date.now()): Promise<Request> {
  const timestamp = String(Math.floor(now / 1000));
  const nonce = randomToken(24);
  return new Request(`${origin}${HOME_ACTIVITY_PATH}`, {
    headers: {
      "x-laterdog-cloud-timestamp": timestamp,
      "x-laterdog-cloud-nonce": nonce,
      "x-laterdog-cloud-signature": `v1=${await activitySignature(secret, timestamp, nonce)}`,
    },
  });
}

export function parseActivity(input: unknown): HomeActivity | null {
  if (!input || typeof input !== "object") return null;
  const { busy, nextAt, work } = input as Record<string, unknown>;
  if (typeof busy !== "boolean") return null;
  if (nextAt !== null && (typeof nextAt !== "number" || !Number.isSafeInteger(nextAt) || nextAt <= 0)) return null;
  const named = Array.isArray(work) ? work.filter((name): name is string => typeof name === "string" && WORK_NAME.test(name)).slice(0, MAX_WORK_NAMES) : [];
  return { busy, nextAt, work: named };
}
