import type { LocaleKey } from "@/locales";
import type { Bot, Task } from "@/state/store";

export type TaskStatus = "needsYou" | "working" | "review" | "open" | "done";

export const TASK_STATUSES: readonly TaskStatus[] = ["needsYou", "working", "review", "open", "done"];
export const DONE_TASKS_KEPT_MS = 7 * 24 * 60 * 60_000;

export const TASK_STATUS_LABEL: Record<TaskStatus, LocaleKey> = {
  needsYou: "tasks.status.needsYou",
  working: "tasks.status.working",
  review: "tasks.status.review",
  open: "tasks.status.open",
  done: "tasks.status.done",
};

export interface DogTask {
  task: Task;
  status: TaskStatus;
  at: number;
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

const statusRank = (status: TaskStatus) => TASK_STATUSES.indexOf(status);

export function dogTasks(bot: Pick<Bot, "tasks">, now = Date.now()): DogTask[] {
  return (bot.tasks ?? [])
    .filter((task) => task.openedBy !== undefined)
    .map((task) => ({ task, status: taskStatus(task), at: taskAt(task) }))
    .filter((row) => row.status !== "done" || now - row.at < DONE_TASKS_KEPT_MS)
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || b.at - a.at);
}

export function tasksWaitingOnYou(rows: readonly DogTask[]): number {
  return rows.filter((row) => row.status === "needsYou" || row.status === "review").length;
}

export function findTask(bots: readonly Bot[], botId: string, threadId: string): { bot: Bot; task: Task } | null {
  const bot = bots.find((candidate) => candidate.id === botId);
  const task = bot?.tasks?.find((candidate) => candidate.threadId === threadId);
  return bot && task ? { bot, task } : null;
}
