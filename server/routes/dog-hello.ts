import { sayFirstHello, type FirstHelloDeps } from "../laterdog/first-hello.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createDogHelloRoutes(deps: FirstHelloDeps, introducer: (auth: RequestAuth) => string | undefined = () => undefined): RouteHandler {
  return async ({ res, method, path, auth, json }) => {
    const match = /^\/api\/bots\/([\w-]+)\/hello$/.exec(path);
    if (!match || method !== "POST") return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Only the owner can introduce a dog" });
    if (!deps.bot(match[1]!)) return json(res, 404, { error: "No such dog" });
    try {
      return json(res, 200, await sayFirstHello(deps, match[1]!, introducer(auth)));
    } catch (error) {
      return json(res, 200, { greeted: true, asked: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
}
