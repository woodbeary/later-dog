import type { ModelSelection } from "../contracts.ts";
import type { ContinueOnResult } from "../laterdog/continue-on-account.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ContinueOnTask {
  id: string;
  threadId: string;
  modelSelection: ModelSelection;
}

export interface ContinueOnRouteDeps {
  task(botId: string, threadId: string): ContinueOnTask;
  refusal(auth: RequestAuth, threadId: string): string | null;
  continueOn(task: ContinueOnTask, instanceId: unknown): ContinueOnResult;
}

export function createContinueOnRoutes(deps: ContinueOnRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const m = path.match(/^\/api\/bots\/([\w-]+)\/continue-on$/);
    if (!m || method !== "POST") return PASS;
    const body = await readBody(req);
    if (typeof body?.threadId !== "string") return json(res, 400, { error: "threadId must be a task id" });
    const task = deps.task(m[1]!, body.threadId);
    const refusal = deps.refusal(auth, task.threadId);
    if (refusal) return json(res, 403, { error: refusal });
    const outcome = deps.continueOn(task, body.instanceId);
    return json(res, outcome.status, outcome.body);
  };
}
