import { existsSync, readFileSync } from "node:fs";

import { PLAN_MAX_ITEMS, PLAN_MAX_TEXT, PLAN_STATUSES, type PlanItem, type PlanStatus, type WirePlan } from "../../shared/dog-plan.ts";
import { writeFileAtomic } from "../atomic.ts";

export const PLAN_CHATS_KEPT = 500;

export type ParsedPlan = { ok: true; items: PlanItem[] } | { ok: false; error: string };

const isStatus = (value: unknown): value is PlanStatus => typeof value === "string" && (PLAN_STATUSES as readonly string[]).includes(value);

export function parsePlanItems(value: unknown): ParsedPlan {
  if (!Array.isArray(value)) return { ok: false, error: "set_plan needs items: the whole list, each { text, status }." };
  if (value.length > PLAN_MAX_ITEMS) return { ok: false, error: `set_plan keeps at most ${PLAN_MAX_ITEMS} items; this list has ${value.length}. Merge or drop finished ones.` };
  const items: PlanItem[] = [];
  for (const [index, entry] of value.entries()) {
    const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const text = typeof row.text === "string" ? row.text.replace(/\s+/g, " ").trim() : "";
    if (!text) return { ok: false, error: `Item ${index + 1} needs text.` };
    if (text.length > PLAN_MAX_TEXT) return { ok: false, error: `Item ${index + 1} is ${text.length} characters; keep each item to ${PLAN_MAX_TEXT}.` };
    if (!isStatus(row.status)) return { ok: false, error: `Item ${index + 1} needs status pending, in_progress or done.` };
    items.push({ text, status: row.status });
  }
  return { ok: true, items };
}

export function engineStatus(value: unknown): PlanStatus {
  if (value === "completed" || value === "done") return "done";
  if (value === "in_progress" || value === "inProgress" || value === "in-progress") return "in_progress";
  return "pending";
}

export function engineSteps(rows: unknown, textKeys: readonly string[]): PlanItem[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((value) => {
    const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const said = textKeys.map((key) => row[key]).find((field) => typeof field === "string" && field.trim());
    const text = typeof said === "string" ? said.replace(/\s+/g, " ").trim().slice(0, PLAN_MAX_TEXT) : "";
    return text ? [{ text, status: engineStatus(row.status) }] : [];
  }).slice(0, PLAN_MAX_ITEMS);
}

export const todoWriteSteps = (input: unknown): PlanItem[] => engineSteps((input as { todos?: unknown } | undefined)?.todos, ["content", "activeForm"]);

export const codexPlanSteps = (plan: unknown): PlanItem[] => engineSteps(plan, ["step"]);

export function planRecorded(items: readonly PlanItem[]): string {
  if (!items.length) return "Plan cleared.";
  const count = (status: PlanStatus) => items.filter((item) => item.status === status).length;
  const current = items.find((item) => item.status === "in_progress");
  return `Plan recorded: ${count("done")} of ${items.length} done${current ? `, now “${current.text}”` : ""}${count("pending") ? `, ${count("pending")} not started` : ""}. The person sees it in the app.`;
}

interface StoredPlan extends WirePlan {
  threadId: string;
  botId?: string;
}

const isStored = (value: unknown): value is StoredPlan => {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : null;
  return Boolean(row && typeof row.threadId === "string" && typeof row.updatedAt === "number" && parsePlanItems(row.items).ok);
};

export class PlanStore {
  private readonly plans = new Map<string, StoredPlan>();
  private readonly path: string | null;
  private readonly now: () => number;
  private readonly kept: number;

  constructor(path: string | null, now: () => number = Date.now, kept = PLAN_CHATS_KEPT) {
    this.path = path;
    this.now = now;
    this.kept = kept;
    if (!path || !existsSync(path)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      for (const row of Array.isArray(parsed) ? parsed.filter(isStored) : []) this.plans.set(row.threadId, row);
    } catch {}
  }

  get(threadId: string): WirePlan | undefined {
    const plan = this.plans.get(threadId);
    return plan ? { items: plan.items.map((item) => ({ ...item })), updatedAt: plan.updatedAt } : undefined;
  }

  set(threadId: string, items: readonly PlanItem[], botId?: string): WirePlan {
    const plan: StoredPlan = { threadId, ...(botId ? { botId } : {}), items: items.slice(0, PLAN_MAX_ITEMS).map((item) => ({ ...item })), updatedAt: this.now() };
    this.plans.delete(threadId);
    this.plans.set(threadId, plan);
    while (this.plans.size > this.kept) this.plans.delete(this.plans.keys().next().value!);
    this.save();
    return this.get(threadId)!;
  }

  forget(threadId: string): boolean {
    const had = this.plans.delete(threadId);
    if (had) this.save();
    return had;
  }

  private save(): void {
    if (this.path) writeFileAtomic(this.path, `${JSON.stringify([...this.plans.values()])}\n`, { mode: 0o600 });
  }
}

export type PlanCaller = "dog" | "helper";

export class PlanCallers {
  private readonly seen = new Map<string, PlanCaller>();
  private readonly waiting = new Map<string, Array<(caller: PlanCaller) => void>>();

  note(toolUseId: unknown, caller: PlanCaller): void {
    if (typeof toolUseId !== "string" || !toolUseId) return;
    this.seen.set(toolUseId, caller);
    while (this.seen.size > 256) this.seen.delete(this.seen.keys().next().value!);
    for (const done of this.waiting.get(toolUseId) ?? []) done(caller);
    this.waiting.delete(toolUseId);
  }

  async of(toolUseId: string | undefined, waitMs: number): Promise<PlanCaller> {
    if (!toolUseId) return "dog";
    const known = this.seen.get(toolUseId);
    if (known) return known;
    return await new Promise<PlanCaller>((resolve) => {
      const done = (caller: PlanCaller) => { clearTimeout(timer); resolve(caller); };
      const timer = setTimeout(() => {
        this.waiting.set(toolUseId, (this.waiting.get(toolUseId) ?? []).filter((waiter) => waiter !== done));
        resolve("dog");
      }, waitMs);
      this.waiting.set(toolUseId, [...(this.waiting.get(toolUseId) ?? []), done]);
    });
  }
}

export type EnginePlanListener = (threadId: string, items: PlanItem[]) => void;

export class EnginePlans {
  private readonly listeners = new Set<EnginePlanListener>();
  readonly callers = new PlanCallers();

  report(threadId: string, items: PlanItem[]): void {
    for (const listener of this.listeners) listener(threadId, items);
  }

  listen(listener: EnginePlanListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const enginePlans = new EnginePlans();
