export interface AutoReviewConfig {
  cloudHome?: boolean;
  features?: { autoReview?: boolean };
}

export function autoReviewOn(config: AutoReviewConfig | null | undefined): boolean {
  return config?.features?.autoReview !== false;
}

export function autoReviewSwitchShown(config: AutoReviewConfig | null | undefined): boolean {
  return config?.cloudHome === true;
}

export function offLeashActsWithoutAsking(config: AutoReviewConfig | null | undefined): boolean {
  return autoReviewSwitchShown(config) && !autoReviewOn(config);
}
