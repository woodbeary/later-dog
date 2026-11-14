import { handleComputerRun, type ComputerRunDeps } from "../laterdog/computer-run-route.ts";
import type { InternalRouteHandler } from "./internal.ts";
import { PASS } from "./table.ts";

export const COMPUTER_RUN_PATH = "/api/internal/computer-run";

export interface ComputerRunRouteDeps extends ComputerRunDeps {
  owns(botId: string, threadId: string): boolean;
  folders(botId: string, threadId: string): string[];
  ready?(roots: string[]): Promise<boolean>;
  active?(capability: unknown): boolean;
}

export function createComputerRunRoute(deps: ComputerRunRouteDeps): InternalRouteHandler {
  return async ({ res, path, method, json, sender, threadId, capability, readBody }) => {
    if (method !== "POST" || path !== COMPUTER_RUN_PATH) return PASS;
    if (!deps.owns(sender.id, threadId)) return json(res, 403, { error: "source conversation does not belong to sender" });
    const body = await readBody();
    const roots = deps.folders(sender.id, threadId);
    if (deps.ready && !await deps.ready(roots)) return json(res, 503, { error: "This chat's files are still coming back from Cloud storage; try again in a moment." });
    const active = deps.active ? () => deps.active!(capability) : undefined;
    const answer = await handleComputerRun({ botId: sender.id, body: body && typeof body === "object" ? body : {}, workingFolder: roots[0] ?? null, allowedRoots: roots, ...(active ? { active } : {}) }, deps);
    return json(res, answer.status, answer.error ? { error: answer.error } : { text: answer.text, failed: answer.failed });
  };
}
