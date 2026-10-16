import type { RequestOutcome } from "../contracts.ts";
import { ownerGuard, type OwnerGuardContext, type OwnerGuardRefusal } from "./owner-guard.ts";

export interface OwnerAutoPermission {
  tool: string;
  command?: string;
}

export type OwnerAutoSettlement = "approved" | "refused" | "failed" | "stale";

export interface OwnerAutoPermissionDeps {
  guard: OwnerGuardContext;
  allow(): Promise<RequestOutcome | "failed">;
  deny(message: string): Promise<RequestOutcome | "failed">;
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

export function ownerAwayKey(threadId: string, requestId: string): string {
  return `${threadId}:${requestId}`;
}

export class OwnerAwayAnswers {
  private readonly keys = new Set<string>();

  mark(threadId: string, requestId: string): void {
    this.keys.add(ownerAwayKey(threadId, requestId));
    if (this.keys.size > 500) this.keys.delete(this.keys.values().next().value!);
  }

  settleSource<T extends string>(threadId: string, requestId: string | undefined, source: T): T | "auto" {
    if (!requestId) return source;
    return this.keys.delete(ownerAwayKey(threadId, requestId)) ? "auto" : source;
  }
}
