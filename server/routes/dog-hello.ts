// POST /api/bots/:id/hello — the welcome flow's last step asks the first dog to speak first (server/laterdog/first-hello.ts).
import { sayFirstHello, type FirstHelloDeps } from "../laterdog/first-hello.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createDogHelloRoutes(deps: FirstHelloDeps): RouteHandler {
  return async ({ res, method, path, auth, json }) => {
    const match = /^\/api\/bots\/([\w-]+)\/hello$/.exec(path);
    if (!match || method !== "POST") return PASS;
    // the owner finishing first run; a paired guest never starts a turn in someone else's dog
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Only the owner can introduce a dog" });
    if (!deps.bot(match[1]!)) return json(res, 404, { error: "No such dog" });
    try {
      return json(res, 200, await sayFirstHello(deps, match[1]!));
    } catch (error) {
      // the greeting already stands; a turn that could not start leaves the chat as it is
      return json(res, 200, { greeted: true, asked: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
}
