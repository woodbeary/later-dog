import { z } from "zod";
import { fromLocalTools } from "../request-auth.ts";
import type { TaskMachineSetting } from "../laterdog/task-machines.ts";
import { PASS, type RouteHandler } from "./table.ts";

const settingSchema = z.object({
  enabled: z.boolean(),
  bots: z.array(z.string().regex(/^[\w-]{1,128}$/)).max(500).optional(),
  cap: z.number().int().min(1).max(100).optional(),
  idleMinutes: z.number().int().min(2).max(30).optional(),
}).strict();

export interface TaskMachineRouteDeps {
  read(): TaskMachineSetting;
  save(setting: TaskMachineSetting): TaskMachineSetting;
  line(): Promise<unknown>;
  configure(settings: { cap?: number; idleMinutes?: number }): Promise<unknown>;
}

export function createTaskMachineRoutes(deps: TaskMachineRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/task-machines") return PASS;
    if (method !== "GET" && method !== "PUT") return json(res, 405, { error: "method_not_allowed" });
    if (!auth.scopes.includes("admin") || fromLocalTools(auth)) return json(res, 403, { error: "Only the owner can choose how tasks get machines." });
    const withLine = async (setting: TaskMachineSetting) => {
      try { return { ...setting, line: await deps.line() }; }
      catch (error) { return { ...setting, lineError: (error as Error).message }; }
    };
    if (method === "GET") return json(res, 200, await withLine(deps.read()));
    const parsed = settingSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "Send enabled: true or false, and optionally bots (dog ids), cap (1 to 100) and idleMinutes (2 to 30)." });
    const { cap, idleMinutes, ...setting } = parsed.data;
    try {
      if (cap !== undefined || idleMinutes !== undefined) await deps.configure({ ...(cap === undefined ? {} : { cap }), ...(idleMinutes === undefined ? {} : { idleMinutes }) });
      return json(res, 200, await withLine(deps.save(setting)));
    } catch (error) { return json(res, 502, { error: (error as Error).message }); }
  };
}
