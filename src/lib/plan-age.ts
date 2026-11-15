import type { Message } from "@/state/store";
import type { WirePlan } from "../../shared/dog-plan";
import { bareToolName } from "./tool-words";

export const PLAN_STALE_MS = 10 * 60_000;

const PLAN_TOOL = /^(?:todowrite|todo_write|update_plan|set_plan)$/;

export function latestWorkAt(messages: readonly Message[]): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") return null;
    if (message.kind === "activity" && PLAN_TOOL.test(bareToolName(message.tool?.name ?? ""))) continue;
    if (message.kind === "activity" || message.kind === "text") return message.at;
  }
  return null;
}

export function planOutOfDate(
  plan: Pick<WirePlan, "items" | "updatedAt"> | null | undefined,
  turnStartedAt: number | null | undefined,
  latestAt: number | null,
  limit = PLAN_STALE_MS,
): boolean {
  if (!plan || !Number.isFinite(plan.updatedAt) || typeof turnStartedAt !== "number") return false;
  if (turnStartedAt <= plan.updatedAt) return false;
  if (!plan.items.some((item) => item.status !== "done")) return false;
  return Math.max(turnStartedAt, latestAt ?? turnStartedAt) - plan.updatedAt >= limit;
}
