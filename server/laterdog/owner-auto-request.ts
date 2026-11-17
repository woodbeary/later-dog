import type { RequestOutcome } from "../contracts.ts";
import { alwaysAsks, type AlwaysAsk } from "./always-asks.ts";
import { ownerGuard, type OwnerGuardContext, type OwnerGuardRefusal } from "./owner-guard.ts";

export interface OwnerAutoPermission {
  tool: string;
  command?: string;
  summary?: string;
  input?: Record<string, unknown>;
}

export type OwnerAutoSettlement = "approved" | "refused" | "held" | "failed" | "stale";

export interface OwnerAutoPermissionDeps {
  guard: OwnerGuardContext;
  allow(): Promise<RequestOutcome | "failed">;
  deny(message: string): Promise<RequestOutcome | "failed">;
  hold?: (question: string, refusal: OwnerGuardRefusal) => void;
  holdAlways?: (hit: AlwaysAsk) => void;
  refusedAlways?: (hit: AlwaysAsk) => void;
  ownerAllows?: (refusal: OwnerGuardRefusal) => boolean;
  isCurrent(): boolean;
  approved(): void;
  refused(refusal: OwnerGuardRefusal): void;
  failed(outcome: RequestOutcome | "failed"): void;
}

export async function settleOwnerAutoPermission(
  request: OwnerAutoPermission,
  deps: OwnerAutoPermissionDeps,
): Promise<OwnerAutoSettlement> {
  const found = await ownerGuard(request, deps.guard);
  const listed = alwaysAsks(request, () => deps.guard);
  const refusal = found?.ask && !listed && deps.ownerAllows?.(found) ? null : found;
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
  const always = listed;
  if (always && always.id !== "delete-outside-workspace") {
    if (deps.holdAlways) {
      if (!deps.isCurrent()) return "stale";
      deps.holdAlways(always);
      return "held";
    }
    await deps.deny(always.refusal);
    if (!deps.isCurrent()) return "stale";
    deps.refusedAlways?.(always);
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
