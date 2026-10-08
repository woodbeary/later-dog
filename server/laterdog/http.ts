import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { repositorySchema, scopePath } from "../../shared/laterdog.ts";
import { json, readBody } from "../harness/http.ts";
import { BridgeStore } from "./bridge-store.ts";
import { ADMIN_SCOPE, DOG_HEADER, authenticateDog, dogScope, secretEquals } from "./dog-access.ts";
import { recordObservation } from "./observations.ts";
import { Supervisor, message } from "./supervisor.ts";

const idSchema = z.string().uuid();
const wakeupSettlementSchema = z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("delivered") }).strict(),
  z.object({ outcome: z.literal("dropped"), reason: z.string().trim().min(1).max(500) }).strict()]);
/** Which dogs have a wake-up waiting, as the hosted Worker reads it (deploy/laterdog/cloudflare/src/wakeup-hint.ts): a JSON list, or "*" past 50. */
export const WAKEUP_BOTS_HEADER = "x-laterdog-wakeup-bots";
export function wakeupReport(bots: string[]): string { return bots.length > 50 ? "*" : JSON.stringify(bots); }
export const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("publish"), summary: z.string().min(1).max(20_000).optional() }).strict(), z.object({ action: z.literal("verify") }).strict(),
  z.object({ action: z.literal("merge") }).strict(), z.object({ action: z.literal("cancel"), acknowledgeUnknown: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal("reconcile"), taskId: z.string().regex(/^(task|session)_[a-zA-Z0-9_-]+$/) }).strict(),
  // writeScopes replaces the parent's paths for this repair, for evidence that puts the fix next door (a shared helper beside the route).
  z.object({ action: z.literal("correct"), brief: z.string().trim().min(1).max(100_000), requestKey: z.string().min(8).max(200),
    writeScopes: z.array(scopePath).min(1).max(40).optional() }).strict(),
  z.object({ action: z.literal("review"), requestKey: z.string().min(8).max(200), profileId: z.string().max(100).optional() }).strict(),
]);
export function createSupervisorServer(supervisor: Supervisor, token: string): Server {
  if (token.length < 32) throw new Error("Supervisor token must contain at least 32 characters");
  const bridge = new BridgeStore(supervisor.store);
  return createServer(async (req,res) => {
    res.setHeader("cache-control", "no-store"); res.setHeader("x-content-type-options", "nosniff");
    if (req.headers.origin) return json(res,403,{ error: "Use the authenticated workspace proxy; direct browser access is disabled" });
    const url = new URL(req.url ?? "/", "http://localhost"); const method = req.method ?? "GET";
    const presented = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    try {
      if (url.pathname === "/v1/bridge/pair" && method === "POST") {
        const body = z.object({ code: z.string().min(20).max(100), label: z.string().trim().min(1).max(100) }).strict().parse(await readBody(req,4096));
        return json(res,200,bridge.pair(body.code,body.label));
      }
      // A request naming a dog must present that dog's derived token (dog-access.ts); it never falls back to admin or device access.
      const dog = authenticateDog(req.headers[DOG_HEADER], presented, token);
      const admin = !dog && secretEquals(presented, token); const device = admin || dog ? undefined : bridge.authenticate(presented);
      if (!admin && !dog && !device) return json(res,401,{ error: "Valid supervisor or paired-device token required" });
      if (device) {
        if (url.pathname === "/v1/bridge/poll" && method === "POST") return json(res,200,{ request: bridge.poll(device) });
        if (url.pathname === "/v1/bridge/result" && method === "POST") {
          const body = z.object({ id: idSchema, result: z.unknown(), failed: z.boolean().default(false) }).strict().parse(await readBody(req,100_000));
          return json(res,200,bridge.result(device,body.id,body.result,body.failed));
        }
        return json(res,403,{ error: "Paired devices may only poll and settle their own local requests" });
      }
      // The admin token reaches every route below; a dog's token only the routes its MCP tools call, for its own jobs.
      const scope = dog ? dogScope(supervisor.store,dog) : ADMIN_SCOPE; scope.check(method,url.pathname);
      const profilePath = /^\/v1\/profiles\/([a-zA-Z0-9_-]+)\/(access|tasks|login)$/.exec(url.pathname);
      if (profilePath && profilePath[2] === "login" && method === "POST") return json(res,202,await supervisor.loginProfile(profilePath[1]));
      if (profilePath && profilePath[2] !== "login" && method === "GET") return json(res,200,profilePath[2] === "tasks" ? await supervisor.listProfileTasks(profilePath[1]) : await supervisor.inspectProfile(profilePath[1]));
      if (url.pathname === "/v1/github/access" && method === "GET") return json(res,200,await supervisor.inspectGitHub());
      if (url.pathname === "/v1/github/login" && method === "POST") return json(res,202,await supervisor.loginGitHub());
      if (url.pathname === "/v1/observations" && method === "POST") return json(res,201,recordObservation(supervisor.store,scope.observation(await readBody(req,30_000))));
      // The admin token's answers say which dogs have a wake-up waiting, so the hosted Worker can let a sleeping container sleep.
      const reportWakeups = () => { if (!dog) res.setHeader(WAKEUP_BOTS_HEADER,wakeupReport(supervisor.store.wakeupBots())); };
      if (url.pathname === "/v1/workspace" && method === "GET") { const snapshot = scope.snapshot(supervisor.snapshot()); reportWakeups(); return json(res,200,snapshot); }
      // A hosted supervisor cannot call the desktop, so the desktop pulls its dogs' wake-ups and settles each one (server/laterdog/wakeups.ts).
      if (url.pathname === "/v1/wakeups/pull" && method === "POST") {
        const body = z.object({ bots: z.array(z.string().regex(/^[\w-]{1,100}$/)).max(1000), limit: z.number().int().min(1).max(50).default(20) }).strict().parse(await readBody(req,120_000));
        const wakeups = supervisor.store.pendingWakeups(new Set(body.bots),body.limit); reportWakeups(); return json(res,200,{ wakeups });
      }
      const wakeupPath = /^\/v1\/wakeups\/(\d{1,15})$/.exec(url.pathname);
      if (wakeupPath && method === "POST") {
        const settled = supervisor.store.settleWakeup(Number(wakeupPath[1]),wakeupSettlementSchema.parse(await readBody(req,4096))); reportWakeups(); return json(res,200,{ settled });
      }
      if (url.pathname === "/v1/verification-policy" && method === "POST") {
        const body = z.object({ repository: repositorySchema.shape.slug, behavioralChecks: repositorySchema.shape.behavioralChecks, verification: repositorySchema.shape.verification }).strict().parse(await readBody(req,50_000));
        const repo = { ...supervisor.store.repository(body.repository), behavioralChecks: body.behavioralChecks, verification: body.verification };
        supervisor.store.saveRepository(repo); return json(res,200,repo);
      }
      if (url.pathname === "/v1/repositories" && method === "POST") {
        const repo = repositorySchema.parse(await readBody(req,50_000)); supervisor.store.saveRepository(repo); return json(res,200,repo);
      }
      if (url.pathname === "/v1/jobs" && method === "POST") return json(res,202,supervisor.create(scope.jobRequest(await readBody(req,200_000))));
      const jobPath = /^\/v1\/jobs\/([\w-]+)(?:\/(action|patch))?$/.exec(url.pathname);
      if (jobPath) {
        const id = idSchema.parse(jobPath[1]);
        if (method === "GET" && !jobPath[2]) return json(res,200,{ job: supervisor.store.job(id), events: supervisor.store.events(id) });
        if (method === "GET" && jobPath[2] === "patch") {
          const job = supervisor.store.job(id); if (!job.patchArtifact) return json(res,404,{ error: "No collected diff" });
          return json(res,200,{ patch: readFileSync(job.patchArtifact,"utf8") });
        }
        if (method === "POST" && jobPath[2] === "action") {
          const body = actionSchema.parse(await readBody(req,120_000));
          const result = body.action === "publish" ? await supervisor.publish(id,body.summary) : body.action === "verify" ? await supervisor.verify(id)
            : body.action === "merge" ? await supervisor.merge(id) : body.action === "cancel" ? supervisor.cancel(id,body.acknowledgeUnknown)
            : body.action === "reconcile" ? await supervisor.reconcile(id,body.taskId)
            : body.action === "correct" ? supervisor.correction(id,body.brief,body.requestKey,body.writeScopes) : supervisor.review(id,body.requestKey,body.profileId);
          return json(res,200,result);
        }
      }
      if (url.pathname === "/v1/bridge/devices" && method === "GET") return json(res,200,{ devices: bridge.devices(), requests: scope.bridgeRequests(bridge.requests()) });
      if (url.pathname === "/v1/bridge/pairing" && method === "POST") {
        const body = z.object({ roots: z.array(z.string().min(1).max(1000)).min(1).max(20), allowAssistance: z.boolean().default(false) }).strict().parse(await readBody(req,30_000));
        return json(res,200,bridge.pairing(body.roots,body.allowAssistance));
      }
      if (url.pathname === "/v1/bridge/requests" && method === "POST") return json(res,202,bridge.create(await readBody(req,70_000),scope.botId));
      const revoke = /^\/v1\/bridge\/devices\/([\w-]+)$/.exec(url.pathname);
      if (revoke && method === "DELETE") { bridge.revoke(idSchema.parse(revoke[1])); return json(res,200,{ revoked: true }); }
      return json(res,404,{ error: "Unknown later.dog operation" });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : error && typeof error === "object" && "status" in error ? Number(error.status) : 409;
      json(res,status,{ error: error instanceof z.ZodError ? error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : message(error) });
    }
  });
}
