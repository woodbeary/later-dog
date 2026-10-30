import { z } from "zod";
import type { TaskOpenedBy } from "../../shared/wire.ts";

export const START_TASKS_PATH = "/api/internal/tasks/start";
export const MAX_NEW_TASKS = 5;

export const startTasksInput = z.object({
  tasks: z.array(z.object({
    title: z.string().trim().min(1).max(60),
    instruction: z.string().trim().min(1).max(4000),
  }).strict()).min(1).max(MAX_NEW_TASKS),
}).strict();

export type StartTasksInput = z.infer<typeof startTasksInput>;

export interface TaskStarter {
  open(title: string, openedBy: TaskOpenedBy): string | null;
  run(threadId: string, instruction: string): Promise<unknown>;
}

export interface StartedTasks {
  started: { threadId: string; title: string }[];
  failed: { title: string; error: string }[];
}

export const TASK_IN_TASK = "You're already working on a task. Do this work here instead of starting more tasks.";

export function startedFromTask(openedBy: TaskOpenedBy | undefined, dogId: string): boolean {
  return openedBy?.kind === "work" && openedBy.botId === dogId;
}

export async function startTasks(
  starter: TaskStarter,
  dog: { id: string; name: string },
  fromThreadId: string,
  input: StartTasksInput,
  now = Date.now(),
): Promise<StartedTasks> {
  const result: StartedTasks = { started: [], failed: [] };
  for (const task of input.tasks) {
    const threadId = starter.open(task.title, { botId: dog.id, name: dog.name, kind: "work", threadId: fromThreadId, at: now });
    if (!threadId) {
      result.failed.push({ title: task.title, error: "it couldn't be opened" });
      continue;
    }
    try {
      await starter.run(threadId, task.instruction);
      result.started.push({ threadId, title: task.title });
    } catch (error) {
      result.failed.push({ title: task.title, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

const quoted = (tasks: { title: string }[]) => tasks.map((task) => `“${task.title}”`).join(", ");

export function startedWords(result: StartedTasks): string {
  const lines: string[] = [];
  if (result.started.length) {
    const count = result.started.length === 1 ? "a task" : `${result.started.length} tasks`;
    lines.push(`Started ${count}: ${quoted(result.started)}. Each works in its own conversation of yours and shows in the person's Tasks list, where they follow it, answer it and mark it done. Its replies stay there, not here. Tell the person in a sentence what you started.`);
  }
  if (result.failed.length) {
    lines.push(`Couldn't start ${quoted(result.failed)}: ${result.failed.map((task) => task.error).join("; ")}. Do that work here instead.`);
  }
  return lines.join(" ");
}
