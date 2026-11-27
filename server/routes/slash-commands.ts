import { z } from "zod";

import { CommandRefused, dogCommands, type DogTrick, type SavedCommands } from "../laterdog/slash-commands.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const SAVED_COMMANDS_PATH = "/api/commands";
const ONE_COMMAND = /^\/api\/commands\/([a-z0-9][a-z0-9-]{0,31})$/;
const DOG_COMMANDS = /^\/api\/bots\/([\w-]+)\/commands$/;

const createSchema = z.object({ name: z.string(), text: z.string() });
const patchSchema = z.object({ name: z.string().optional(), text: z.string().optional() })
  .refine((patch) => patch.name !== undefined || patch.text !== undefined);

export interface SlashCommandRouteDeps {
  saved: SavedCommands;
  tricks(botId: string): readonly DogTrick[] | null | Promise<readonly DogTrick[] | null>;
}

export function createSlashCommandRoutes(deps: SlashCommandRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const answer = (run: () => { status: number; body: unknown }) => {
      try {
        const { status, body } = run();
        return json(res, status, body);
      } catch (error) {
        if (error instanceof CommandRefused) return json(res, error.status, { error: error.message });
        throw error;
      }
    };
    const dog = DOG_COMMANDS.exec(path);
    if (dog) {
      if (method !== "GET") return json(res, 405, { error: "method_not_allowed" });
      const tricks = await deps.tricks(dog[1]);
      if (!tricks) return json(res, 404, { error: "no such bot" });
      return json(res, 200, { commands: dogCommands(deps.saved.list(), tricks) });
    }
    if (path === SAVED_COMMANDS_PATH) {
      if (method === "GET") return json(res, 200, { commands: deps.saved.list() });
      if (method !== "POST") return json(res, 405, { error: "method_not_allowed" });
      const body = createSchema.safeParse(await readBody(req));
      if (!body.success) return json(res, 400, { error: "Give the command a name and the text it sends." });
      return answer(() => ({ status: 201, body: { command: deps.saved.create(body.data.name, body.data.text) } }));
    }
    const one = ONE_COMMAND.exec(path);
    if (!one) return PASS;
    if (method === "DELETE") return answer(() => (deps.saved.remove(one[1]), { status: 200, body: { ok: true } }));
    if (method !== "PATCH") return json(res, 405, { error: "method_not_allowed" });
    const body = patchSchema.safeParse(await readBody(req));
    if (!body.success) return json(res, 400, { error: "Send a new name, new text, or both." });
    return answer(() => ({ status: 200, body: { command: deps.saved.update(one[1], body.data) } }));
  };
}
