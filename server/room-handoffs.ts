import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import {
  HANDOFF_CEILING_MS, HANDOFF_HARD_CAP_MS, HANDOFF_IDLE_MS, HANDOFF_ENDS, HandoffBudget, endWords, endedForTime,
  type HandoffActivity, type HandoffEnd,
} from "./laterdog/handoff-budget.ts";
import { timedOutAgain, type HandoffRunResult } from "./laterdog/long-work.ts";

const nodeSchema = z.object({
  id: z.string(), rootId: z.string(), parentId: z.string().optional(),
  groupId: z.string().optional(), threadId: z.string(), botId: z.string(),
  key: z.string(), text: z.string(), createdAt: z.number(),
  requestBatchKey: z.string().optional(),
  status: z.enum(["source", "queued", "running", "waiting", "resume", "completed", "failed", "cancelled"]),
  result: z.string().default(""), reported: z.boolean().default(false),
  executions: z.number().int().nonnegative().default(0), startedAt: z.number().optional(),
  lastProgressAt: z.number().optional(),
  approvalGranted: z.boolean().default(false),
  kind: z.enum(["work", "assignment"]).default("work"),
  endedBy: z.enum(HANDOFF_ENDS).optional(),
  continueOffered: z.boolean().optional(),
  continuedAs: z.string().optional(),
  firstCreatedAt: z.number().optional(),
  retried: z.boolean().optional(),
  restarted: z.boolean().optional(),
});
export type RoomHandoff = z.infer<typeof nodeSchema>;
export type RoomAddress = Pick<RoomHandoff, "groupId" | "threadId" | "botId">;
export const ROOM_HANDOFF_LIMITS = { depth: 4, requests: 24, executions: 48, idleMs: HANDOFF_IDLE_MS, minRunwayMs: 10 * 60_000, hardCapMs: HANDOFF_HARD_CAP_MS, ceilingMs: HANDOFF_CEILING_MS };
const terminal = (n: RoomHandoff) => ["completed", "failed", "cancelled"].includes(n.status);
const addressOf = (n: RoomHandoff): RoomAddress => ({ groupId: n.groupId, threadId: n.threadId, botId: n.botId });
const CONTINUE_NOTE = "\n\n[Continuing: your earlier attempt at this stopped because time ran out. Check what is already done, then carry on from where it stopped.]";

export interface RoomHandoffHooks {
  validate(node: RoomHandoff, parent?: RoomHandoff): string | undefined;
  busy(node: RoomHandoff): boolean;
  run(node: RoomHandoff, resumed: boolean, signal: AbortSignal): Promise<HandoffRunResult>;
  report(child: RoomHandoff, parent: RoomHandoff): void;
  changed(groupIds: ReadonlySet<string>, directThreadIds: ReadonlySet<string>): void;
  activity?(node: RoomHandoff): HandoffActivity | undefined;
  closed?(root: RoomHandoff, end: HandoffEnd): void;
  longWork?(node: RoomHandoff): boolean;
  continued?(old: RoomHandoff, root: RoomHandoff, end: HandoffEnd): void;
  restarted?(root: RoomHandoff, nodes: RoomHandoff[], resumed: boolean): void;
}

export class RoomHandoffs {
  readonly nodes = new Map<string, RoomHandoff>();
  private readonly controllers = new Map<string, AbortController>();
  private loadError?: string;
  private readonly file: string;
  private readonly hooks: RoomHandoffHooks;
  private readonly now: () => number;
  private readonly limits: typeof ROOM_HANDOFF_LIMITS;
  private readonly budget: HandoffBudget;
  private readonly longCache = new Map<string, { at: number; long: boolean }>();
  private restartPending = false;

  constructor(file: string, hooks: RoomHandoffHooks, now: () => number = Date.now,
    limits: Partial<typeof ROOM_HANDOFF_LIMITS> = {}) {
    this.file = file; this.hooks = hooks; this.now = now;
    this.limits = { ...ROOM_HANDOFF_LIMITS, ...limits };
    this.budget = new HandoffBudget(this.limits, now);
    try {
      const saved = z.array(nodeSchema).max(10_000).parse(JSON.parse(readFileSync(file, "utf8")));
      const ids = new Map(saved.map(n => [n.id, n]));
      if (ids.size !== saved.length || saved.some(n => !ids.has(n.rootId) || ids.get(n.rootId)?.parentId ||
        (n.parentId && (!ids.has(n.parentId) || ids.get(n.parentId)?.rootId !== n.rootId)))) throw new Error("Invalid room handoff tree");
      for (const n of saved) this.nodes.set(n.id, n);
      if (hooks.longWork) this.restartPending = saved.some(n => !terminal(n));
      else {
        for (const n of saved) if (!terminal(n)) this.lostToRestart(n);
        this.save();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.loadError = "Room handoff storage is unreadable; repair it before sending new work.";
    }
  }

  private save() { writeFileAtomic(this.file, JSON.stringify([...this.nodes.values()]), { mode: 0o600 }); }
  private publish(...nodes: RoomHandoff[]) {
    this.save();
    this.hooks.changed(new Set(nodes.flatMap(node => node.groupId ? [node.groupId] : [])),
      new Set(nodes.filter(node => !node.groupId).map(node => node.threadId)));
  }
  children(id: string) { return [...this.nodes.values()].filter(n => n.parentId === id); }
  root(n: RoomHandoff) { return this.nodes.get(n.rootId)!; }
  path(n: RoomHandoff): RoomHandoff[] {
    const path: RoomHandoff[] = [];
    for (let cur: RoomHandoff | undefined = n; cur; cur = cur.parentId ? this.nodes.get(cur.parentId) : undefined) {
      if (path.some(p => p.id === cur!.id)) throw new Error("Invalid handoff ancestry");
      path.unshift(cur);
    }
    return path;
  }

  private lostToRestart(n: RoomHandoff): void {
    n.status = "failed"; n.result = endWords("restart", this.limits); n.endedBy = "restart";
  }
  private longTree(rootId: string): boolean {
    if (!this.hooks.longWork) return false;
    const cached = this.longCache.get(rootId);
    if (cached && this.now() - cached.at < 30_000) return cached.long;
    const tree = [...this.nodes.values()].filter(n => n.rootId === rootId);
    let long = false;
    try { long = tree.length > 0 && tree.every(n => this.hooks.longWork!(n)); } catch { long = false; }
    this.longCache.set(rootId, { at: this.now(), long });
    return long;
  }
  private settleRestart(): void {
    if (!this.restartPending) return;
    this.restartPending = false;
    const roots = [...new Set([...this.nodes.values()].filter(n => !terminal(n)).map(n => n.rootId))];
    const plans = roots.map(rootId => ({ rootId, long: this.longTree(rootId) }));
    for (const { rootId, long } of plans) {
      const root = this.nodes.get(rootId);
      const open = [...this.nodes.values()].filter(n => n.rootId === rootId && !terminal(n));
      if (!root) continue;
      if (long) {
        for (const n of open) {
          if (n.status === "source") { n.status = "waiting"; continue; }
          if (n.status !== "running") continue;
          const children = this.children(n.id);
          if (children.some(c => !terminal(c))) n.status = "waiting";
          else if (children.length) n.status = "resume";
          else { n.status = "queued"; n.restarted = true; }
        }
        this.stampProgress(root);
        const picked = open.filter(n => n.parentId);
        if (picked.length) this.hooks.restarted?.(root, picked, true);
        continue;
      }
      const lost = this.children(rootId).filter(c => !terminal(c));
      for (const n of open) {
        this.lostToRestart(n);
        if (this.hooks.restarted && n.parentId === rootId) n.reported = true;
      }
      if (lost.length) this.hooks.restarted?.(root, lost, false);
    }
    this.save();
  }
  private stampProgress(root: RoomHandoff): void {
    root.lastProgressAt = Math.max(root.lastProgressAt ?? root.createdAt, this.now());
  }
  private owesOnlySynthesis(n: RoomHandoff): boolean {
    const children = this.children(n.id);
    return children.length > 0 && children.every(c => terminal(c)) &&
      (n.status === "running" || (n.status === "resume" && !this.hooks.busy(n)));
  }
  private progressOf(n: RoomHandoff): number | undefined {
    if (n.status === "source" || n.status === "queued" || n.status === "resume") return this.now();
    if (n.status !== "running") return undefined;
    return this.budget.runningProgressAt(this.hooks.activity?.(n), n.startedAt ?? n.createdAt);
  }
  private observeProgress(): void {
    for (const n of this.nodes.values()) {
      if (terminal(n)) continue;
      const at = this.progressOf(n);
      if (at !== undefined) this.budget.note(n.rootId, at);
    }
  }
  private idleRoots(): Set<string> {
    const idle = new Set<string>();
    for (const n of this.nodes.values()) {
      if (terminal(n) || idle.has(n.rootId)) continue;
      const root = this.nodes.get(n.rootId);
      if (root && this.budget.idle(root)) idle.add(root.id);
    }
    return idle;
  }
  private timeEnd(n: RoomHandoff, idle: ReadonlySet<string>): "idle" | "capped" | "ceiling" | undefined {
    const root = this.root(n);
    const long = this.longTree(root.id);
    if (this.budget.pastHardCap(root, long)) {
      const end = long ? "ceiling" : "capped";
      if (!this.owesOnlySynthesis(n)) return end;
      if (n.status === "running" && this.now() > (n.startedAt ?? n.createdAt) + this.limits.minRunwayMs) return end;
      return undefined;
    }
    return idle.has(root.id) ? "idle" : undefined;
  }
  private timeText(n: RoomHandoff, end: "idle" | "capped" | "ceiling"): string {
    const first = endWords(end, this.limits);
    const settled = [...this.nodes.values()]
      .filter(x => x.rootId === n.rootId && x.parentId && terminal(x) && x.status !== "cancelled")
      .map(x => `${x.key} [${x.status}] ${x.result.slice(-512)}`);
    if (!settled.length) return first;
    const lines: string[] = [];
    let used = 0;
    for (const line of settled) {
      if (used + line.length + 1 > 4096) break;
      lines.push(line); used += line.length + 1;
    }
    const elided = settled.length - lines.length;
    return `${first}\n${lines.join("\n")}${elided ? `\n(+${elided} elided)` : ""}`;
  }

  enqueue(source: RoomAddress, generation: string, parentId: string | undefined,
    target: RoomAddress, key: string, text: string, approvalGranted = false,
    rework = false, sourceText = "", requestBatchKey?: string): { node: RoomHandoff; duplicate: boolean } {
    if (this.loadError) throw new Error(this.loadError);
    this.settleRestart();
    let parent = parentId ? this.nodes.get(parentId) : this.nodes.get(generation);
    if (parentId && (!parent || parent.status !== "running")) throw new Error("The originating room task is no longer running");
    if (parent && (parent.groupId !== source.groupId || parent.threadId !== source.threadId || parent.botId !== source.botId)) {
      throw new Error("The handoff belongs to a different room speaker");
    }
    const fresh = !parent;
    parent ??= { ...source, id: generation, rootId: generation, key: "root", text: sourceText.slice(0, 12_000), createdAt: this.now(), status: "source", result: "", reported: true, executions: 0, approvalGranted: false, kind: "work" };
    const kind = target.groupId && target.groupId === source.groupId ? "assignment" : "work";
    const path = this.path(parent);
    if (path.some(n => n.botId === target.botId && (!n.groupId || !target.groupId || n.groupId === target.groupId))) {
      throw new Error("Cannot assign work back to an ancestor; results return automatically");
    }
    const existing = this.children(parent.id).findLast(n => n.botId === target.botId && n.groupId === target.groupId && n.text === text);
    if (existing && !(rework && terminal(existing))) return { node: existing, duplicate: true };
    if (!rework && this.children(parent.id).some(n => n.kind === kind &&
      n.groupId === target.groupId && n.botId === target.botId && n.status === "completed")) {
      throw new Error("This agent already completed your assignment. Do not send acknowledgements or approvals as new work. Finish with your decision; results return automatically. Only use rework=true for concrete additional work.");
    }
    if (kind === "work" && target.groupId && path.some(n => n.groupId === target.groupId)) throw new Error("A room request cannot return to an ancestor room; results are returned automatically");
    if (kind === "work" && path.filter(n => n.kind === "work").length > this.limits.depth) throw new Error("Room handoff depth limit reached");
    const root = fresh ? parent : this.root(parent);
    const count = [...this.nodes.values()].filter(n => n.rootId === parent!.rootId && n.parentId).length;
    if (count >= this.limits.requests) throw new Error("Room handoff budget exhausted");
    const long = !fresh && this.longTree(root.id);
    if (!this.budget.hasRunway(root, long)) throw new Error(this.budget.refusal(root, long));
    if (this.nodes.size >= 1000) {
      const oldRoots = [...this.nodes.values()].filter(n => !n.parentId && terminal(n)).sort((a, b) => a.createdAt - b.createdAt);
      for (const old of oldRoots) {
        if (this.nodes.size < 800) break;
        for (const n of this.nodes.values()) if (n.rootId === old.id) this.nodes.delete(n.id);
        this.budget.forget(old.id);
        this.longCache.delete(old.id);
      }
      if (this.nodes.size >= 1000) throw new Error("Too many active room requests");
    }
    const node: RoomHandoff = { ...target, id: randomUUID(), rootId: parent.rootId, parentId: parent.id,
      key, text, createdAt: this.now(), status: "queued", result: "", reported: false, executions: 0, approvalGranted,
      kind, ...(target.groupId && requestBatchKey ? { requestBatchKey } : {}) };
    const problem = this.hooks.validate(node, parent);
    if (problem) throw new Error(problem);
    if (fresh) this.nodes.set(parent.id, parent);
    this.nodes.set(node.id, node);
    this.longCache.delete(root.id);
    const previousProgress = root.lastProgressAt;
    this.stampProgress(root);
    try { this.publish(node, parent); } catch (e) {
      this.nodes.delete(node.id); if (fresh) this.nodes.delete(parent.id); else root.lastProgressAt = previousProgress;
      throw e;
    }
    return { node, duplicate: false };
  }

  sharedRequest(node: RoomHandoff): { id: string; botIds: string[] } {
    const batch = node.groupId && node.requestBatchKey && node.parentId
      ? this.children(node.parentId).filter(n => n.requestBatchKey === node.requestBatchKey &&
        n.groupId === node.groupId && n.threadId === node.threadId && n.text === node.text)
      : [node];
    return { id: batch[0]?.id ?? node.id, botIds: batch.map(n => n.botId) };
  }

  sourceSettled(generation: string, ok: boolean) {
    const node = this.nodes.get(generation);
    if (!node || node.status !== "source") return;
    if (!ok) node.result = "The originating turn ended before its teammates returned.";
    node.status = "waiting";
    this.publish(node);
  }

  cancelTree(node: RoomHandoff, reason: string, status: "failed" | "cancelled" = "cancelled", by: HandoffEnd = "problem") {
    for (const child of this.children(node.id)) if (!terminal(child)) this.cancelTree(child, reason, status, by);
    if (!terminal(node)) {
      node.status = status; node.result = reason; node.endedBy = by;
      this.controllers.get(node.id)?.abort(by);
      this.stampProgress(this.root(node));
    }
    this.publish(node);
  }
  cancelRoom(groupId: string, threadId?: string, by: HandoffEnd = "person") {
    for (const n of this.nodes.values()) {
      if (n.groupId === groupId && (!threadId || n.threadId === threadId) && !terminal(n)) this.cancelTree(n, endWords(by, this.limits), "cancelled", by);
    }
  }
  cancelDirect(threadId: string, by: HandoffEnd = "person") {
    for (const n of this.nodes.values()) {
      if (!n.groupId && n.threadId === threadId && !terminal(n)) this.cancelTree(n, endWords(by, this.limits), "cancelled", by);
    }
  }
  activeDirect(threadId: string) {
    return [...this.nodes.values()].some(n => !n.groupId && n.threadId === threadId && !terminal(n));
  }
  assignerOf(threadId: string): RoomHandoff | undefined {
    for (const node of this.nodes.values()) {
      if (terminal(node) || !node.parentId || node.groupId || node.threadId !== threadId) continue;
      const parent = this.nodes.get(node.parentId);
      if (parent) return parent;
    }
    return undefined;
  }
  outstandingDirect(threadId: string): RoomHandoff[] {
    return [...this.nodes.values()].filter(node => {
      if (terminal(node) || !node.parentId) return false;
      const parent = this.nodes.get(node.parentId);
      return Boolean(parent && !parent.groupId && parent.threadId === threadId);
    });
  }
  stopAwaitingDirect(threadId: string, by: HandoffEnd = "person"): RoomHandoff[] {
    const left: RoomHandoff[] = [];
    for (const node of this.nodes.values()) {
      if (node.groupId || node.threadId !== threadId || terminal(node)) continue;
      for (const child of this.children(node.id)) {
        if (terminal(child)) continue;
        if (child.status === "queued") this.cancelTree(child, endWords(by, this.limits, true), "cancelled", by);
        else left.push(child);
      }
      node.status = "cancelled"; node.result = endWords(by, this.limits); node.endedBy = by;
      this.controllers.get(node.id)?.abort(by);
      this.publish(node);
    }
    return left;
  }

  private continuesOnItsOwn(old: RoomHandoff): boolean {
    if (old.endedBy === "ceiling" || !this.longTree(old.id) || !this.continuable(old.id) || !this.budget.hasRunway(old, true)) return false;
    try {
      const { rootId } = this.continueTree(old.id);
      this.hooks.continued?.(old, this.nodes.get(rootId)!, old.endedBy!);
      return true;
    } catch {
      return false;
    }
  }

  continuable(rootId: string): boolean {
    const root = this.nodes.get(rootId);
    return Boolean(root && !root.parentId && terminal(root) && endedForTime(root.endedBy) && !root.continuedAs &&
      this.children(root.id).some(child => child.status !== "completed"));
  }

  continueTree(rootId: string): { rootId: string; resent: number; kept: number } {
    if (this.loadError) throw new Error(this.loadError);
    const old = this.nodes.get(rootId);
    if (!old || old.parentId) throw new Error("There is no such work to continue.");
    if (old.continuedAs) throw new Error("This work was already continued.");
    if (!this.continuable(rootId)) throw new Error("Nothing is waiting to be continued here.");
    const generation = randomUUID();
    const source = addressOf(old);
    const created: string[] = [];
    const root: RoomHandoff = { ...source, id: generation, rootId: generation, key: "root", text: old.text, createdAt: this.now(),
      firstCreatedAt: old.firstCreatedAt ?? old.createdAt, status: "source", result: "", reported: true, executions: 0, approvalGranted: false, kind: "work" };
    this.nodes.set(root.id, root);
    created.push(root.id);
    let resent = 0; let kept = 0;
    try {
      const children = this.children(old.id);
      for (const child of children.filter(c => c.status === "completed")) {
        const copy: RoomHandoff = { ...child, id: randomUUID(), rootId: generation, parentId: generation, reported: true };
        this.nodes.set(copy.id, copy);
        created.push(copy.id);
        kept++;
      }
      for (const child of children.filter(c => c.status !== "completed")) {
        const { node } = this.enqueue(source, generation, undefined, addressOf(child), child.key,
          `${child.text.replace(CONTINUE_NOTE, "")}${CONTINUE_NOTE}`, child.approvalGranted, true, old.text, child.requestBatchKey);
        created.push(node.id);
        resent++;
      }
    } catch (error) {
      for (const id of created) this.nodes.delete(id);
      this.budget.forget(generation);
      throw error;
    }
    old.continuedAs = generation;
    this.sourceSettled(generation, true);
    this.publish(old, root);
    return { rootId: generation, resent, kept };
  }

  tick() {
    if (this.loadError) return;
    this.settleRestart();
    this.observeProgress();
    const idle = this.idleRoots();
    for (const n of [...this.nodes.values()].reverse()) {
      if (terminal(n)) continue;
      const error = this.hooks.validate(n, n.parentId ? this.nodes.get(n.parentId) : undefined);
      if (error) { this.cancelTree(n, error, "failed", "problem"); continue; }
      const end = this.timeEnd(n, idle);
      if (end) this.cancelTree(n, this.timeText(n, end), "failed", end);
    }
    for (const n of Array.from(this.nodes.values())) {
      if (n.parentId || !terminal(n) || n.continueOffered || !(endedForTime(n.endedBy) || n.endedBy === "ceiling")) continue;
      n.continueOffered = true;
      if (this.continuesOnItsOwn(n)) continue;
      this.publish(n);
      this.hooks.closed?.(n, n.endedBy!);
    }
    for (const n of this.nodes.values()) {
      const parent = n.parentId ? this.nodes.get(n.parentId) : undefined;
      if (terminal(n) && parent && !n.reported) {
        this.hooks.report(n, parent); n.reported = true; this.publish(n, parent);
      }
      if (n.status === "waiting") {
        const children = this.children(n.id);
        if (children.length && children.every(c => terminal(c) && c.reported)) { n.status = "resume"; this.publish(n); }
      }
      if (n.status !== "queued" && n.status !== "resume") continue;
      if (parent && (parent.status === "source" || parent.status === "running") &&
        (parent.threadId === n.threadId || (n.groupId && n.groupId === parent.groupId))) continue;
      if (parent && terminal(parent) && n.status === "queued") { this.cancelTree(n, endWords("origin", this.limits), "cancelled", "origin"); continue; }
      if (this.hooks.busy(n)) continue;
      const root = this.root(n);
      const executionCost = 1;
      if (root.executions + executionCost > this.limits.executions) { this.cancelTree(n, endWords("limit", this.limits), "failed", "limit"); continue; }
      const resumed = n.status === "resume";
      const childCount = this.children(n.id).length;
      root.executions += executionCost; n.status = "running"; n.startedAt = this.now();
      this.stampProgress(root);
      this.publish(n, root);
      const controller = new AbortController();
      this.controllers.set(n.id, controller);
      void this.hooks.run(n, resumed, controller.signal).then(result => {
        if (terminal(n)) return;
        n.restarted = undefined;
        n.result = result.text.slice(0, 12_000);
        if (this.children(n.id).length > childCount) n.status = "waiting";
        else if (!result.ok && result.timedOut && !n.retried) { n.retried = true; n.status = resumed ? "resume" : "queued"; this.stampProgress(root); }
        else if (!result.ok && result.timedOut) this.cancelTree(n, timedOutAgain(n.result), "failed", "timeout");
        else if (!result.ok) this.cancelTree(n, n.result || "Room agent failed", "failed", "problem");
        else { n.status = "completed"; this.stampProgress(root); }
        this.publish(n);
      }).catch(e => {
        if (terminal(n)) return;
        n.result = String(e).slice(0, 1000);
        if (this.children(n.id).length > childCount) {
          n.status = "waiting";
          this.publish(n);
        } else this.cancelTree(n, n.result, "failed", "problem");
      })
        .finally(() => this.controllers.delete(n.id));
    }
  }
}
