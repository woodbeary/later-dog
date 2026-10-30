import type { ApprovalMode } from "../../shared/approval-mode.ts";

export interface AutoReviewFeatures {
  autoReview?: boolean;
}

export function autoReviewOn(features: AutoReviewFeatures | undefined): boolean {
  return features?.autoReview === true;
}

export function ownerTurnMode(saved: ApprovalMode, owner: boolean): ApprovalMode {
  return owner && saved !== "full" && saved !== "custom" ? "auto" : saved;
}
