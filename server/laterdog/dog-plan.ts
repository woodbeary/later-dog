import { existsSync, readFileSync, renameSync } from "node:fs";

import { PLAN_MAX_ITEMS, PLAN_MAX_TEXT, PLAN_STATUSES, planLeftCount, type PlanItem, type PlanStatus, type WirePlan } from "../../shared/dog-plan.ts";
import { writeFileAtomic } from "../atomic.ts";

export const PLAN_CHATS_KEPT = 500;

export type ParsedPlan = { ok: true; items: PlanItem[] } | { ok: false; error: string };

const HIDDEN = /[\p{Cc}\p{Cf}]/gu;
const VISIBLE = /[^\s\u200D]/u;

export function visibleText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").replace(HIDDEN, (char) => char === "\u200D" ? char : "").replace(/ {2,}/g, " ").trim();
  return VISIBLE.test(text) ? text : "";
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function cutToFit(text: string, max = PLAN_MAX_TEXT): string {
  if (text.length <= max) return text;
  let kept = "";
  for (const { segment } of graphemes.segment(text)) {
    if (kept.length + segment.length > max) break;
    kept += segment;
  }
  return kept.trimEnd();
}

const isStatus = (value: unknown): value is PlanStatus => typeof value === "string" && (PLAN_STATUSES as readonly string[]).includes(value);

export function parsePlanItems(value: unknown): ParsedPlan {
  if (!Array.isArray(value)) return { ok: false, error: "set_plan needs items: the whole list, each { text, status }." };
  if (value.length > PLAN_MAX_ITEMS) return { ok: false, error: `set_plan keeps at most ${PLAN_MAX_ITEMS} items; this list has ${value.length}. Merge or drop finished ones.` };
  const items: PlanItem[] = [];
  for (const [index, entry] of value.entries()) {
    const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const text = visibleText(row.text);
    if (!text) return { ok: false, error: `Item ${index + 1} needs text that can be seen.` };
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

export function engineSteps(rows: unknown, textKeys: readonly string[]): PlanItem[] | null {
  if (!Array.isArray(rows)) return null;
  const items = rows.flatMap((value) => {
    const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const text = cutToFit(textKeys.map((key) => visibleText(row[key])).find(Boolean) ?? "");
    return text ? [{ text, status: engineStatus(row.status) }] : [];
  }).slice(0, PLAN_MAX_ITEMS);
  return items.length || !rows.length ? items : null;
}

export const todoWriteSteps = (input: unknown): PlanItem[] | null => engineSteps((input as { todos?: unknown } | undefined)?.todos, ["content", "activeForm"]);

export const codexPlanSteps = (plan: unknown): PlanItem[] | null => engineSteps(plan, ["step"]);

const PLAN_SEEN = " The person sees it in the app.";
const PLAN_OUT_OF_VIEW = " A finished plan leaves the chat, which is expected. Add items only for new work.";

export function planRecorded(items: readonly PlanItem[], shown = true): string {
  if (!items.length) return `Plan cleared.${shown ? PLAN_SEEN : ""}`;
  const count = (status: PlanStatus) => items.filter((item) => item.status === status).length;
  const current = items.find((item) => item.status === "in_progress");
  const seen = !shown ? "" : planLeftCount({ items }) ? PLAN_SEEN : PLAN_OUT_OF_VIEW;
  return `Plan recorded: ${count("done")} of ${items.length} done${current ? `, now “${current.text}”` : ""}${count("pending") ? `, ${count("pending")} not started` : ""}.${seen}`;
}

interface PlanVersion extends WirePlan {
  anchorId?: string;
}

interface StoredPlan extends WirePlan {
  threadId: string;
  botId?: string;
  anchorId?: string;
  versions?: PlanVersion[];
  current?: number | null;
}

interface ThreadPlans {
  botId?: string;
  versions: PlanVersion[];
  current: number | null;
}

export const PLAN_VERSIONS_KEPT = 8;

const isStored = (value: unknown): value is StoredPlan => {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : null;
  return Boolean(row && typeof row.threadId === "string" && typeof row.updatedAt === "number" && parsePlanItems(row.items).ok);
};

const copyVersion = (version: PlanVersion): PlanVersion =>
  ({ items: version.items.map((item) => ({ ...item })), updatedAt: version.updatedAt, ...(version.anchorId ? { anchorId: version.anchorId } : {}) });

function threadPlansOf(row: StoredPlan): ThreadPlans {
  const versions = Array.isArray(row.versions)
    ? row.versions.filter((version) => typeof version?.updatedAt === "number" && parsePlanItems(version.items).ok).map(copyVersion)
    : [copyVersion(row)];
  const current = row.current === null ? null
    : typeof row.current === "number" && Number.isInteger(row.current) && row.current >= 0 && row.current < versions.length ? row.current
      : versions.length ? versions.length - 1 : null;
  return { ...(row.botId ? { botId: row.botId } : {}), versions, current };
}

export class PlanStore {
  private readonly plans = new Map<string, ThreadPlans>();
  private readonly path: string | null;
  private readonly now: () => number;
  private readonly kept: number;

  constructor(path: string | null, now: () => number = Date.now, kept = PLAN_CHATS_KEPT) {
    this.path = path;
    this.now = now;
    this.kept = kept;
    if (!path || !existsSync(path)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      parsed = undefined;
    }
    if (!Array.isArray(parsed)) {
      this.setAside(path);
      return;
    }
    for (const row of parsed.filter(isStored)) this.plans.set(row.threadId, threadPlansOf(row));
  }

  private setAside(path: string): void {
    try {
      renameSync(path, corruptPlansPath(path));
    } catch {}
  }

  get(threadId: string): WirePlan | undefined {
    const plans = this.plans.get(threadId);
    const plan = plans && plans.current !== null ? plans.versions[plans.current] : undefined;
    return plan ? { items: plan.items.map((item) => ({ ...item })), updatedAt: plan.updatedAt } : undefined;
  }

  set(threadId: string, items: readonly PlanItem[], botId?: string, anchorId?: string): WirePlan {
    const earlier = this.plans.get(threadId);
    const version: PlanVersion = { items: items.slice(0, PLAN_MAX_ITEMS).map((item) => ({ ...item })), updatedAt: this.now(), ...(anchorId ? { anchorId } : {}) };
    const versions = [...(earlier?.versions ?? []), version].slice(-PLAN_VERSIONS_KEPT);
    this.plans.delete(threadId);
    this.plans.set(threadId, { ...(botId ?? earlier?.botId ? { botId: botId ?? earlier?.botId } : {}), versions, current: versions.length - 1 });
    while (this.plans.size > this.kept) this.plans.delete(this.plans.keys().next().value!);
    this.save();
    return this.get(threadId)!;
  }

  follow(threadId: string, onPath: (messageId: string) => boolean): boolean {
    const plans = this.plans.get(threadId);
    if (!plans) return false;
    const found = plans.versions.findLastIndex((version) => version.anchorId !== undefined && onPath(version.anchorId));
    const current = found === -1 ? null : found;
    if (current === plans.current) return false;
    plans.current = current;
    this.save();
    return true;
  }

  forget(threadId: string): boolean {
    const had = this.plans.delete(threadId);
    if (had) this.save();
    return had;
  }

  private save(): void {
    if (!this.path) return;
    const rows: StoredPlan[] = [...this.plans.entries()].map(([threadId, plans]) => {
      const shown = plans.current === null ? { items: [], updatedAt: plans.versions.at(-1)?.updatedAt ?? 0 } : plans.versions[plans.current];
      return { threadId, ...(plans.botId ? { botId: plans.botId } : {}), items: shown.items, updatedAt: shown.updatedAt, versions: plans.versions, current: plans.current };
    });
    writeFileAtomic(this.path, `${JSON.stringify(rows)}\n`, { mode: 0o600 });
  }
}

export const corruptPlansPath = (path: string): string => path.replace(/(\.json)?$/, ".corrupt.json");

export type PlanCaller = "dog" | "helper";

export const PLAN_CALLERS_KEPT = 2_048;

export class PlanCallers {
  private readonly seen = new Map<string, PlanCaller>();
  private readonly waiting = new Map<string, Array<(caller: PlanCaller) => void>>();

  note(toolUseId: unknown, caller: PlanCaller): void {
    if (typeof toolUseId !== "string" || !toolUseId) return;
    this.seen.set(toolUseId, caller);
    while (this.seen.size > PLAN_CALLERS_KEPT) this.seen.delete(this.seen.keys().next().value!);
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

export interface ThreadChanges {
  onChange(listener: (change: { type: string; threadId?: string }) => void): () => void;
}

export function forgetDeletedChats(changes: ThreadChanges, plans: Pick<PlanStore, "forget">): () => void {
  return changes.onChange((change) => {
    if (change.type === "thread.deleted" && change.threadId) plans.forget(change.threadId);
  });
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
