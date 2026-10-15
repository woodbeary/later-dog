import { hasNativeAutoReview, type ApprovalMode } from "../../shared/approval-mode.ts";
import type { AutoVerdict, AutoVerdictSource } from "../auto-approve.ts";

export interface AutoReviewScope {
  autoReview: boolean;
  cloudHome: boolean;
  driverKind: string | undefined;
  lastPersonVia: string | undefined;
}

export type AutoReviewKept = "on" | "not-off-leash" | "not-cloud" | "engine-shows-heel" | "local-tool";

export function autoReviewKept(level: ApprovalMode, scope: AutoReviewScope): AutoReviewKept | null {
  if (scope.autoReview) return "on";
  if (level !== "auto") return "not-off-leash";
  if (!scope.cloudHome) return "not-cloud";
  if (scope.driverKind === "antigravityAgent") return "engine-shows-heel";
  if (scope.lastPersonVia === "api") return "local-tool";
  return null;
}

export function reviewSkipped(level: ApprovalMode, scope: AutoReviewScope): boolean {
  return autoReviewKept(level, scope) === null;
}

export function engineApprovalMode(level: ApprovalMode, scope: AutoReviewScope): ApprovalMode {
  return reviewSkipped(level, scope) && hasNativeAutoReview(scope.driverKind) ? "ask" : level;
}

export function reviewedVerdict(
  verdict: AutoVerdict,
  request: { tool: string; skipped: boolean; approvalScope?: string },
): AutoVerdict {
  if (!request.skipped || request.approvalScope === "local-computer" || verdict.source !== "native-approval") return verdict;
  return { approve: `approved ${request.tool} (Auto-review off)`, source: "auto-review-off" };
}

export function announcesApproval(source: AutoVerdictSource): boolean {
  return source !== "auto-review-off";
}

export function approvalGrantName(source: AutoVerdictSource): string {
  if (source === "command-allowlist") return "the saved command permission";
  if (source === "auto-review-off") return "Auto-review being off";
  return "Full access";
}
