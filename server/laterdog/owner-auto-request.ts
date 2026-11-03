import type { RequestOutcome } from "../contracts.ts";
import { ownerGuard, type OwnerGuardContext, type OwnerGuardRefusal } from "./owner-guard.ts";

export interface OwnerAutoPermission {
  tool: string;
  command?: string;
}

export type OwnerAutoSettlement = "approved" | "refused" | "held" | "failed" | "stale";

export interface OwnerAutoPermissionDeps {
  guard: OwnerGuardContext;
  allow(): Promise<RequestOutcome | "failed">;
  deny(message: string): Promise<RequestOutcome | "failed">;
  hold?: (question: string, refusal: OwnerGuardRefusal) => void;
  isCurrent(): boolean;
  approved(): void;
  refused(refusal: OwnerGuardRefusal): void;
  failed(outcome: RequestOutcome | "failed"): void;
}

export async function settleOwnerAutoPermission(
  request: OwnerAutoPermission,
  deps: OwnerAutoPermissionDeps,
): Promise<OwnerAutoSettlement> {
  const refusal = await ownerGuard(request, deps.guard);
  if (refusal?.ask && deps.hold) {
    if (!deps.isCurrent()) return "stale";
    deps.hold(refusal.ask, refusal);
    return "held";
  }
  if (refusal) {
    await deps.deny(refusal.message);
    if (!deps.isCurrent()) return "stale";
    deps.refused(refusal);
    return "refused";
  }
  const outcome = await deps.allow();
  if (!deps.isCurrent()) return "stale";
  if (outcome !== "allowed-once") {
    deps.failed(outcome);
    return "failed";
  }
  deps.approved();
  return "approved";
}
