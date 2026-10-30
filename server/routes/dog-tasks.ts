import type { ZodError } from "zod";
import { START_TASKS_PATH, startedWords, startTasks, startTasksInput, TASK_IN_TASK, type TaskStarter } from "../laterdog/dog-tasks.ts";
import type { BotRecord } from "../store.ts";
import type { InternalRouteHandler } from "./internal.ts";
import { PASS } from "./table.ts";

export interface DogTaskRouteDeps {
  active(capability: unknown): boolean;
  insideTask(sender: BotRecord, threadId: string): boolean;
  starter(sender: BotRecord, threadId: string): TaskStarter;
}

function problems(error: ZodError): string {
  return `Check the request: ${error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`;
}

export function createDogTaskRoute(deps: DogTaskRouteDeps): InternalRouteHandler {
  return async ({ res, path, method, json, readBody, capability, sender, threadId }) => {
    if (method !== "POST" || path !== START_TASKS_PATH) return PASS;
    if (!deps.active(capability)) return json(res, 401, { error: "the internal turn capability has expired" });
    const parsed = startTasksInput.safeParse(await readBody());
    if (!parsed.success) return json(res, 400, { error: problems(parsed.error) });
    if (deps.insideTask(sender, threadId)) return json(res, 409, { error: TASK_IN_TASK });
    const result = await startTasks(deps.starter(sender, threadId), sender, threadId, parsed.data);
    return json(res, result.started.length ? 200 : 409, { ...result, text: startedWords(result) });
  };
}
