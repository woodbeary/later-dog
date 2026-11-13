export const PLAN_STATUSES = ["pending", "in_progress", "done"] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface PlanItem {
  text: string;
  status: PlanStatus;
}

export interface WirePlan {
  items: PlanItem[];
  updatedAt: number;
}

export const PLAN_MAX_ITEMS = 20;
export const PLAN_MAX_TEXT = 200;

export function planDoneCount(plan: Pick<WirePlan, "items">): number {
  return plan.items.filter((item) => item.status === "done").length;
}
