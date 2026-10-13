export const TAKEOVER_REASONS = ["sign-in", "captcha", "payment", "other"] as const;
export type TakeoverReason = (typeof TAKEOVER_REASONS)[number];
export type TakeoverStatus = "waiting" | "in-control" | "done" | "skipped" | "replied";
export type TakeoverPlace = "cloud" | "vm" | "local" | "browser";

export interface TakeoverRequestCardData {
  step: string;
  reason: TakeoverReason;
  helpRequestId: string;
  status: TakeoverStatus;
  place?: TakeoverPlace;
}

export function isOpenTakeover(status: TakeoverStatus): boolean {
  return status === "waiting" || status === "in-control";
}
