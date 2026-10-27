import { z } from "zod";
import type { MacRelayQueue } from "../laterdog/mac-relay.ts";
import { mirrorProfileSchema, type MacRelayMirrors } from "../laterdog/mac-relay-mirrors.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const MAC_RELAY_OWNER_ONLY = "Only the owner's own signed-in Mac can relay its Dev dogs.";
export const MAC_RELAY_NOT_RELAYED = "That dog isn't relayed from a Mac.";
export const MAC_RELAY_JOB_GONE = "No such job, or it already timed out.";

const MIRROR = /^\/api\/mac-relay\/mirrors\/([\w-]{1,80})$/;
const NEXT = /^\/api\/mac-relay\/bots\/([\w-]{1,80})\/job$/;
const FINISH = /^\/api\/mac-relay\/jobs\/([\w-]{1,80})\/(result|fail)$/;

const resultBody = z.object({ text: z.string().min(1).max(200_000) }).strict();
const failBody = z.object({ message: z.string().min(1).max(2000) }).strict();

export interface MacRelayRouteDeps {
  cloudHome: boolean;
  mayRelay(auth: RequestAuth): boolean;
  queue: MacRelayQueue;
  mirrors: MacRelayMirrors;
}

export function createMacRelayRoutes(deps: MacRelayRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/mac-relay/") || !deps.cloudHome) return PASS;
    const mirror = MIRROR.exec(path);
    const next = NEXT.exec(path);
    const finish = FINISH.exec(path);
    if (!(mirror && method === "PUT") && !(next && method === "GET") && !(finish && method === "POST")) return PASS;
    if (!deps.mayRelay(auth)) return json(res, 403, { error: MAC_RELAY_OWNER_ONLY });
    if (mirror) {
      const profile = mirrorProfileSchema.safeParse(await readBody(req, 16_000));
      if (!profile.success) return json(res, 400, { error: "A relayed dog needs a name, and may have a title, description and colour." });
      return json(res, 200, deps.mirrors.ensure(mirror[1]!, profile.data));
    }
    if (next) {
      if (!deps.mirrors.isRelayBot(next[1]!)) return json(res, 404, { error: MAC_RELAY_NOT_RELAYED });
      return json(res, 200, { job: deps.queue.nextJob(next[1]!) });
    }
    const [, jobId, outcome] = finish!;
    const raw = await readBody(req, 256_000);
    if (outcome === "result") {
      const parsed = resultBody.safeParse(raw);
      if (!parsed.success) return json(res, 400, { error: "A relay result needs text." });
      return deps.queue.completeJob(jobId!, parsed.data.text) ? json(res, 200, { ok: true }) : json(res, 404, { error: MAC_RELAY_JOB_GONE });
    }
    const parsed = failBody.safeParse(raw);
    if (!parsed.success) return json(res, 400, { error: "A relay failure needs a message." });
    return deps.queue.failJob(jobId!, parsed.data.message) ? json(res, 200, { ok: true }) : json(res, 404, { error: MAC_RELAY_JOB_GONE });
  };
}
