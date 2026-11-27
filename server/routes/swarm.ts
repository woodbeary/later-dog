import type { ZodError } from "zod";
import type { ModelSelection } from "../../shared/wire.ts";
import { TASK_IN_TASK } from "../laterdog/dog-tasks.ts";
import { START_SWARM_PATH, startedSwarmWords, startSwarmInput, type StartSwarmInput, type SwarmBook, type SwarmStarter } from "../laterdog/swarm.ts";
import type { BotRecord } from "../store.ts";
import type { InternalRouteHandler } from "./internal.ts";
import { PASS } from "./table.ts";

export interface SwarmRouteDeps {
  book: SwarmBook;
  active(capability: unknown): boolean;
  insideTask(sender: BotRecord, threadId: string): boolean;
  selections(sender: BotRecord, threadId: string, input: StartSwarmInput): ModelSelection[];
  starter(sender: BotRecord, threadId: string): SwarmStarter;
  settled(threadId: string): void;
  accountName(instanceId: string): string;
}

function problems(error: ZodError): string {
  return `Check the request: ${error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`;
}

export function createSwarmRoute(deps: SwarmRouteDeps): InternalRouteHandler {
  return async ({ res, path, method, json, readBody, capability, sender, threadId }) => {
    if (method !== "POST" || path !== START_SWARM_PATH) return PASS;
    if (!deps.active(capability)) return json(res, 401, { error: "the internal turn capability has expired" });
    const parsed = startSwarmInput.safeParse(await readBody());
    if (!parsed.success) return json(res, 400, { error: problems(parsed.error) });
    if (deps.insideTask(sender, threadId)) return json(res, 409, { error: TASK_IN_TASK });
    const { record, failed } = await deps.book.start(deps.starter(sender, threadId), sender.id, threadId, parsed.data,
      deps.selections(sender, threadId, parsed.data), deps.settled);
    if (!record.parts.length) return json(res, 409, { error: `The swarm could not start: ${failed.map((part) => part.error).join("; ")}. Do the work here instead.` });
    return json(res, 200, { swarm: record.id, parts: record.parts.map((part) => ({ title: part.title, task: part.threadId, account: part.instanceId })), text: startedSwarmWords(record, failed, deps.accountName) });
  };
}
