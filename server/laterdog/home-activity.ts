import { createHmac, timingSafeEqual } from "node:crypto";

export const HOME_ACTIVITY_PATH = "/api/cloud/activity";
export const HOME_ACTIVITY_SKEW_S = 120;
const NONCE_MS = 5 * 60_000;
const MAX_NONCES = 2_000;

export type HomeWork = "turn" | "routine" | "queued" | "cloud_job" | "upkeep";

export interface HomeActivity {
  busy: boolean;
  nextAt: number | null;
  work: HomeWork[];
}

export interface HomeWorkSignals {
  routines: { hold: boolean; reason?: "running" | "due"; at?: number };
  turns: boolean;
  queued: boolean;
  cloudJobs: boolean;
  upkeep: boolean;
}

export function homeActivitySignature(secret: string, timestamp: string, nonce: string): string {
  return createHmac("sha256", secret).update(`v1\n${timestamp}\n${nonce}\nGET\n${HOME_ACTIVITY_PATH}`).digest("base64url");
}

export function createHomeActivity(options: { secret: string; activity: () => HomeActivity; now?: () => number }) {
  const now = options.now ?? Date.now;
  const nonces = new Map<string, number>();
  return {
    handle(input: { timestamp: string | undefined; nonce: string | undefined; signature: string | undefined }): { status: number; body: Record<string, unknown> } {
      const timestamp = input.timestamp ?? "", nonce = input.nonce ?? "";
      const presented = /^v1=([A-Za-z0-9_-]{43})$/.exec(input.signature ?? "")?.[1];
      const expected = Buffer.from(homeActivitySignature(options.secret, timestamp, nonce), "base64url");
      const given = presented ? Buffer.from(presented, "base64url") : Buffer.alloc(expected.length);
      if (!presented || given.length !== expected.length || !timingSafeEqual(given, expected) || !/^\d{1,12}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
        return { status: 401, body: { error: "invalid_signature" } };
      }
      const at = now();
      if (Math.abs(at / 1000 - Number(timestamp)) > HOME_ACTIVITY_SKEW_S) return { status: 401, body: { error: "stale_request" } };
      for (const [seen, until] of nonces) if (until <= at) nonces.delete(seen);
      if (nonces.has(nonce)) return { status: 401, body: { error: "replayed_request" } };
      if (nonces.size >= MAX_NONCES) return { status: 503, body: { error: "busy" } };
      nonces.set(nonce, at + NONCE_MS);
      const activity = options.activity();
      return { status: 200, body: { busy: activity.busy, nextAt: activity.nextAt, work: activity.work } };
    },
  };
}

export const HOME_ACTIVITY_HORIZON_MS = 30 * 24 * 60 * 60_000;

export function homeActivityFrom(signals: HomeWorkSignals): HomeActivity {
  const named: Array<[HomeWork, boolean]> = [
    ["turn", signals.turns],
    ["routine", signals.routines.reason === "running"],
    ["queued", signals.queued],
    ["cloud_job", signals.cloudJobs],
    ["upkeep", signals.upkeep],
  ];
  const work = named.filter(([, going]) => going).map(([name]) => name);
  const { reason, at } = signals.routines;
  return { busy: work.length > 0, nextAt: reason === "due" && typeof at === "number" ? at : null, work };
}
