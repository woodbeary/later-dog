import type { LocaleKey } from "@/locales";
import type { Bot, Task } from "@/state/store";

export type TaskStatus = "needsYou" | "working" | "review" | "open" | "done";
export type TaskSort = "status" | "dog";

export const TASK_STATUSES: readonly TaskStatus[] = ["needsYou", "working", "review", "open", "done"];
export const DONE_TASKS_KEPT_MS = 7 * 24 * 60 * 60_000;

export const TASK_STATUS_LABEL: Record<TaskStatus, LocaleKey> = {
  needsYou: "tasks.status.needsYou",
  working: "tasks.status.working",
  review: "tasks.status.review",
  open: "tasks.status.open",
  done: "tasks.status.done",
};

export interface TaskRow {
  bot: Bot;
  task: Task;
  status: TaskStatus;
  at: number;
}

export interface TaskSection {
  key: string;
  status?: TaskStatus;
  bot?: Bot;
  rows: TaskRow[];
}

export function taskStatus(task: Task): TaskStatus {
  if (task.archivedAt !== undefined || task.closedBy) return "done";
  if (task.activity === "waiting-on-you") return "needsYou";
  if (task.busy || task.activity === "working") return "working";
  if (task.unread) return "review";
  return "open";
}

function taskAt(task: Task): number {
  return task.archivedAt ?? task.updatedAt ?? task.createdAt;
}

export function taskRows(bots: readonly Bot[], now = Date.now()): TaskRow[] {
  return bots.flatMap((bot) => (bot.tasks ?? [])
    .filter((task) => task.openedBy !== undefined)
    .map((task) => ({ bot, task, status: taskStatus(task), at: taskAt(task) }))
    .filter((row) => row.status !== "done" || now - row.at < DONE_TASKS_KEPT_MS));
}

const statusRank = (status: TaskStatus) => TASK_STATUSES.indexOf(status);
const newestFirst = (a: TaskRow, b: TaskRow) => b.at - a.at;

export function taskSections(rows: readonly TaskRow[], sort: TaskSort): TaskSection[] {
  if (sort === "status") {
    return TASK_STATUSES
      .map((status) => ({ key: status, status, rows: rows.filter((row) => row.status === status).sort(newestFirst) }))
      .filter((section) => section.rows.length > 0);
  }
  const byDog = new Map<string, TaskSection>();
  for (const row of rows) {
    const section = byDog.get(row.bot.id) ?? { key: row.bot.id, bot: row.bot, rows: [] };
    section.rows.push(row);
    byDog.set(row.bot.id, section);
  }
  return [...byDog.values()]
    .map((section) => ({ ...section, rows: section.rows.sort((a, b) => statusRank(a.status) - statusRank(b.status) || newestFirst(a, b)) }))
    .sort((a, b) => statusRank(a.rows[0]!.status) - statusRank(b.rows[0]!.status) || a.bot!.name.localeCompare(b.bot!.name));
}

export function tasksWaitingOnYou(rows: readonly TaskRow[]): number {
  return rows.filter((row) => row.status === "needsYou" || row.status === "review").length;
}

export function findTask(bots: readonly Bot[], botId: string, threadId: string): { bot: Bot; task: Task } | null {
  const bot = bots.find((candidate) => candidate.id === botId);
  const task = bot?.tasks?.find((candidate) => candidate.threadId === threadId);
  return bot && task ? { bot, task } : null;
}
