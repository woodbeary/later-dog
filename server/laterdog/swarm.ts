import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ModelSelection } from "../../shared/wire.ts";
import { writeFileAtomic } from "../atomic.ts";
import { percentLeft, restApplies, selectionOnAccount, type BatteryAccount, type PlanReading, type Rest } from "./account-battery.ts";
import { readText } from "./read-text.ts";

export const START_SWARM_PATH = "/api/internal/swarm/start";
export const MIN_SWARM_PARTS = 2;
export const MAX_SWARM_PARTS = 8;
export const SWARM_DEADLINE_MS = 2 * 60 * 60 * 1000;
export const STAY_ON_PARENT_PERCENT = 50;
export const PART_REPLY_MAX = 4_000;
export const GATHER_MAX = 24_000;
export const KEPT_SWARMS = 200;
export const SWARM_WATCH_MS = 30_000;
export const SWARM_SETTLE_RETRIES_MS: readonly number[] = [500, 3_000, 10_000];

export const startSwarmInput = z.object({
  goal: z.string().trim().min(1).max(400),
  parts: z.array(z.object({
    title: z.string().trim().min(1).max(60),
    instruction: z.string().trim().min(1).max(4000),
    size: z.enum(["small", "large"]).optional(),
  }).strict()).min(MIN_SWARM_PARTS).max(MAX_SWARM_PARTS),
  gather: z.string().trim().min(1).max(2000),
}).strict();

export type StartSwarmInput = z.infer<typeof startSwarmInput>;

export type PartState = "running" | "done" | "failed";

export interface SwarmPart {
  threadId: string;
  title: string;
  instanceId: string;
  state: PartState;
  reply?: string;
  endedAt?: number;
}

export interface SwarmRecord {
  id: string;
  botId: string;
  parentThreadId: string;
  goal: string;
  gather: string;
  parts: SwarmPart[];
  startedAt: number;
  deadline: number;
  gatheredAt?: number;
}

export interface SpreadInput {
  parent: ModelSelection;
  count: number;
  accounts: readonly BatteryAccount[];
  usage?: PlanReading;
  resting: Readonly<Record<string, Rest>>;
  now: number;
  preferred?: readonly ModelSelection[];
}

const usable = (account: BatteryAccount, model: string | undefined, resting: Readonly<Record<string, Rest>>, now: number) =>
  account.eligible && account.enabled && account.signedIn !== false && !restApplies(resting[account.instanceId], model, now);

export function spreadParts(input: SpreadInput): ModelSelection[] {
  const own = input.accounts.find((account) => account.instanceId === input.parent.instanceId);
  if (!own) return Array.from({ length: input.count }, () => input.parent);
  const left = (account: BatteryAccount) => percentLeft(input.usage?.(account.instanceId), input.now);
  const ownLeft = left(own);
  if (ownLeft !== undefined && ownLeft > STAY_ON_PARENT_PERCENT) return Array.from({ length: input.count }, () => input.parent);
  const ranked = input.accounts
    .filter((account) => account.driverKind === own.driverKind && usable(account, input.parent.model, input.resting, input.now) && left(account) !== 0)
    .map((account, index) => ({ account, left: left(account), index }))
    .sort((a, b) => (a.left === undefined ? 1 : 0) - (b.left === undefined ? 1 : 0) || (b.left ?? 0) - (a.left ?? 0) || a.index - b.index)
    .map(({ account }) => account);
  if (!ranked.length) return Array.from({ length: input.count }, () => input.parent);
  return Array.from({ length: input.count }, (_, index) => {
    const account = ranked[index % ranked.length]!;
    return account.instanceId === input.parent.instanceId ? input.parent : selectionOnAccount(input.parent, account, input.accounts, input.preferred);
  });
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function gatherText(record: SwarmRecord, now: number): string {
  const late = record.parts.filter((part) => part.state === "running");
  const parts = record.parts.map((part) => ({
    title: part.title, state: part.state, task: part.threadId,
    reply: part.reply ? cut(part.reply, PART_REPLY_MAX) : part.state === "running" ? "still working at the deadline" : "no reply",
  }));
  const intro = late.length && now >= record.deadline
    ? `Your swarm for "${record.goal}" reached its deadline with ${late.length} of ${record.parts.length} parts still working.`
    : `Your swarm for "${record.goal}" has finished all ${record.parts.length} parts.`;
  const ask = `Write the person one answer from these results, following your gather instructions: ${record.gather} Name any part that failed or is still working. The parts' replies are your own tasks' work, and their task conversations hold the details.`;
  return cut(`${intro} ${ask}\n${readText("your swarm's parts", JSON.stringify(parts))}`, GATHER_MAX);
}

export function startedSwarmWords(record: SwarmRecord, failed: readonly { title: string; error: string }[], accountName: (instanceId: string) => string): string {
  const lines = [`Started a swarm of ${record.parts.length} parts for "${record.goal}": ${record.parts.map((part) => `“${part.title}” on ${accountName(part.instanceId)}`).join(", ")}. Each runs as its own task. When all are done, or after two hours, their results come back here in one message and you write the answer. Tell the person in a sentence what you started, then stop; don't wait or check on the parts.`];
  if (failed.length) lines.push(`Couldn't start ${failed.map((part) => `“${part.title}”`).join(", ")}: ${failed.map((part) => part.error).join("; ")}.`);
  return lines.join(" ");
}

export interface SwarmStarter {
  open(title: string, selection: ModelSelection, size: "small" | "large" | undefined): string | null;
  run(threadId: string, instruction: string, settled: () => void): Promise<unknown>;
}

export class SwarmBook {
  private records: SwarmRecord[] | null = null;

  private readonly file: string | undefined;
  private readonly now: () => number;

  constructor(file: string | undefined, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
  }

  private load(): SwarmRecord[] {
    if (this.records) return this.records;
    try {
      const parsed = this.file ? JSON.parse(readFileSync(this.file, "utf8")) as unknown : [];
      this.records = Array.isArray(parsed) ? parsed as SwarmRecord[] : [];
    } catch {
      this.records = [];
    }
    return this.records;
  }

  private save(): void {
    const kept = this.load().sort((a, b) => b.startedAt - a.startedAt).slice(0, KEPT_SWARMS);
    this.records = kept;
    if (this.file) writeFileAtomic(this.file, `${JSON.stringify(kept)}\n`, { mode: 0o600 });
  }

  list(): readonly SwarmRecord[] {
    return this.load();
  }

  async start(starter: SwarmStarter, botId: string, parentThreadId: string, input: StartSwarmInput, selections: readonly ModelSelection[], onSettled: (threadId: string) => void) {
    const now = this.now();
    const record: SwarmRecord = { id: randomUUID(), botId, parentThreadId, goal: input.goal, gather: input.gather, parts: [], startedAt: now, deadline: now + SWARM_DEADLINE_MS };
    const failed: { title: string; error: string }[] = [];
    const opened: { part: SwarmPart; instruction: string }[] = [];
    input.parts.forEach((part, index) => {
      const selection = selections[index]!;
      const threadId = starter.open(part.title, selection, part.size);
      if (!threadId) { failed.push({ title: part.title, error: "it couldn't be opened" }); return; }
      opened.push({ part: { threadId, title: part.title, instanceId: selection.instanceId, state: "running" }, instruction: part.instruction });
    });
    record.parts = opened.map(({ part }) => part);
    if (record.parts.length) {
      this.load().push(record);
      this.save();
    }
    for (const { part, instruction } of opened) {
      try {
        await starter.run(part.threadId, instruction, () => onSettled(part.threadId));
      } catch (error) {
        this.ended(part.threadId, "failed", error instanceof Error ? error.message : String(error));
        failed.push({ title: part.title, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { record, failed };
  }

  ended(threadId: string, state: Exclude<PartState, "running">, reply: string | undefined): SwarmRecord | undefined {
    const record = this.load().find((entry) => entry.gatheredAt === undefined && entry.parts.some((part) => part.threadId === threadId));
    const part = record?.parts.find((entry) => entry.threadId === threadId);
    if (!record || !part || part.state !== "running") return undefined;
    part.state = state;
    part.endedAt = this.now();
    if (reply) part.reply = cut(reply, PART_REPLY_MAX);
    this.save();
    return record;
  }

  due(): SwarmRecord[] {
    const now = this.now();
    return this.load().filter((record) => record.gatheredAt === undefined &&
      (record.parts.every((part) => part.state !== "running") || now >= record.deadline));
  }

  open(): SwarmRecord[] {
    return this.load().filter((record) => record.gatheredAt === undefined);
  }

  gathered(id: string): void {
    const record = this.load().find((entry) => entry.id === id);
    if (!record || record.gatheredAt !== undefined) return;
    record.gatheredAt = this.now();
    this.save();
  }

  partOf(threadId: string): SwarmRecord | undefined {
    return this.load().find((record) => record.parts.some((part) => part.threadId === threadId));
  }
}
