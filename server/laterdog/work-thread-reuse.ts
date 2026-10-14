import type { TaskRecord } from "../store.ts";

export interface WorkThreadQuery {
  senderId: string;
  sourceThreadId: string;
  projectId?: string;
}

type ReusableTask = Pick<TaskRecord, "threadId" | "openedBy" | "closedBy" | "archivedAt" | "projectId" | "updatedAt" | "createdAt">;

export function openWorkThread<T extends ReusableTask>(tasks: readonly T[], query: WorkThreadQuery): T | undefined {
  const candidates = tasks.filter((task) => {
    const opened = task.openedBy;
    if (!opened || opened.botId !== query.senderId || opened.threadId !== query.sourceThreadId) return false;
    if (task.archivedAt !== undefined) return false;
    if (query.projectId !== undefined && task.projectId !== query.projectId) return false;
    return opened.kind === "work" || task.closedBy === undefined;
  });
  const settled = (task: T) => task.updatedAt ?? task.createdAt;
  return candidates.sort((a, b) =>
    Number(b.openedBy?.kind === "work") - Number(a.openedBy?.kind === "work") || settled(b) - settled(a))[0];
}

export const MAX_OWN_THREADS_PER_TURN = 5;
export const MAX_TEAMMATE_THREADS_PER_TURN = 15;

export class TeammateThreadCount {
  private readonly counts = new WeakMap<object, number>();

  opened(turn: object): number {
    return this.counts.get(turn) ?? 0;
  }

  note(turn: object): void {
    this.counts.set(turn, this.opened(turn) + 1);
  }
}

export function threadLimitMessage(limit: number, kind: "own" | "teammate" = "own"): string {
  const where = kind === "own" ? "for yourself" : "with teammates";
  return `You have already opened ${limit} new threads ${where} this turn, which is the limit that stops a runaway loop. A request to a teammate you already have an open thread with goes into that thread and does not count. Do not retry: finish your turn and tell the person plainly which threads you still wanted to open, so they can open them or ask you again.`;
}

export function threadLimitNotice(limit: number): string {
  return `notice: This dog opened ${limit} new threads in one go, so later.dog paused new ones to stop a runaway. Ask again if you want more.`;
}

export function reusedThreadMessage(title: string, name: string): string {
  return `Added to your open thread #${title} with ${name}. It runs after anything still running there, and its result comes back to you there.`;
}
