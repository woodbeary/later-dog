import type { ApprovalMode } from "../../shared/approval-mode.ts";

export interface AutoReviewFeatures {
  autoReview?: boolean;
}

export interface DogBeforeAutoReview {
  approvalMode?: unknown;
  autoApprove?: unknown;
}

export function autoReviewOn(features: AutoReviewFeatures | undefined): boolean {
  return features?.autoReview !== false;
}

export function autoReviewFromDogs(dogs: readonly DogBeforeAutoReview[], cloudHome: boolean): boolean {
  if (!cloudHome) return true;
  return !dogs.some((dog) => dog.approvalMode === "auto" || (dog.approvalMode === undefined && dog.autoApprove === true));
}

export function ownerTurnMode(saved: ApprovalMode, owner: boolean): ApprovalMode {
  return owner && saved !== "full" && saved !== "custom" ? "auto" : saved;
}
