import { PASS, type RouteHandler } from "./table.ts";

export type ComputerChange = "reset" | "update";

export interface ComputerChangeBot {
  id: string;
  name: string;
  cloudBackend?: string;
}

export interface ComputerChangeRouteDeps {
  bot(id: string): ComputerChangeBot | undefined;
  busy(botId: string): boolean;
  controlHeld(botId: string): boolean;
  claim(botId: string): () => void;
  change(action: ComputerChange, botId: string): Promise<{ state: string }>;
}

const PATH = /^\/api\/bots\/([\w-]+)\/computer\/(reset|update)$/;

export const ONLY_LATERDOG_COMPUTERS = "Reset and Update work on later.dog cloud computers only";
export const busyRefusal = (name: string) => `${name} is working. Stop it first, then try again.`;
export const heldRefusal = (name: string) => `You're using ${name}'s computer. Hand it back first.`;

export function createComputerChangeRoutes(deps: ComputerChangeRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json }) => {
    const match = PATH.exec(path);
    if (!match || method !== "POST") return PASS;
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return json(res, 415, { error: "content-type must be application/json" });
    }
    const bot = deps.bot(match[1]!);
    if (!bot) return json(res, 404, { error: "no such bot" });
    if (bot.cloudBackend === "vps") return json(res, 409, { error: ONLY_LATERDOG_COMPUTERS });
    if (deps.busy(bot.id)) return json(res, 409, { error: busyRefusal(bot.name) });
    if (deps.controlHeld(bot.id)) return json(res, 409, { error: heldRefusal(bot.name) });
    const release = deps.claim(bot.id);
    try {
      return json(res, 200, await deps.change(match[2] as ComputerChange, bot.id));
    } finally {
      release();
    }
  };
}
