import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { pipeline } from "node:stream";
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
export const WAKEUP_BOTS_HEADER = "x-laterdog-wakeup-bots";
export function wakeupReport(bots: string[]): string { return bots.length > 50 ? "*" : JSON.stringify(bots); }
export const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("publish"), summary: z.string().min(1).max(20_000).optional() }).strict(), z.object({ action: z.literal("verify") }).strict(),
  z.object({ action: z.literal("merge") }).strict(), z.object({ action: z.literal("cancel"), acknowledgeUnknown: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal("reconcile"), taskId: z.string().regex(/^(task|session)_[a-zA-Z0-9_-]+$/) }).strict(),
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
      const scope = dog ? dogScope(supervisor.store,dog) : ADMIN_SCOPE; scope.check(method,url.pathname);
      const profilePath = /^\/v1\/profiles\/([a-zA-Z0-9_-]+)\/(access|tasks|login)$/.exec(url.pathname);
      if (profilePath && profilePath[2] === "login" && method === "POST") return json(res,202,await supervisor.loginProfile(profilePath[1]));
      if (profilePath && profilePath[2] !== "login" && method === "GET") return json(res,200,profilePath[2] === "tasks" ? await supervisor.listProfileTasks(profilePath[1]) : await supervisor.inspectProfile(profilePath[1]));
      if (url.pathname === "/v1/github/access" && method === "GET") return json(res,200,await supervisor.inspectGitHub());
      if (url.pathname === "/v1/github/login" && method === "POST") return json(res,202,await supervisor.loginGitHub());
      if (url.pathname === "/v1/observations" && method === "POST") return json(res,201,recordObservation(supervisor.store,scope.observation(await readBody(req,30_000))));
      const reportWakeups = () => { if (!dog) res.setHeader(WAKEUP_BOTS_HEADER,wakeupReport(supervisor.store.wakeupBots())); };
      if (url.pathname === "/v1/workspace" && method === "GET") { const snapshot = scope.snapshot(supervisor.snapshot()); reportWakeups(); return json(res,200,snapshot); }
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
      if (url.pathname === "/v1/jobs" && method === "POST") {
        const body = await readBody(req,200_000);
        const profileDefaulted = Boolean(body && typeof body === "object" && !Array.isArray(body) && !("profileId" in body));
        if (profileDefaulted) (body as Record<string, unknown>).profileId = supervisor.preferredProfile(typeof (body as Record<string, unknown>).account === "string" ? (body as Record<string, string>).account : undefined);
        const request = scope.jobRequest(body);
        await supervisor.ensureRepository(request);
        return json(res,202,supervisor.create(request,{ profileDefaulted }));
      }
      if (url.pathname === "/v1/jobs" && method === "GET") {
        const ids = url.searchParams.get("ids");
        const query = ids !== null
          ? { ids: z.array(idSchema).max(100).parse(ids.split(",").filter(Boolean)) }
          : { botId: z.string().regex(/^[\w-]{1,100}$/).optional().parse(url.searchParams.get("bot") ?? undefined), limit: z.coerce.number().int().min(1).max(100).default(20).parse(url.searchParams.get("limit") ?? undefined) };
        return json(res,200,{ jobs: supervisor.summaries(query) });
      }
      const jobPath = /^\/v1\/jobs\/([\w-]+)(?:\/(action|patch|activity|screen|trace))?$/.exec(url.pathname);
      if (jobPath) {
        const id = idSchema.parse(jobPath[1]);
        if (method === "GET" && !jobPath[2]) return json(res,200,{ job: supervisor.store.job(id), events: supervisor.store.events(id) });
        if (method === "GET" && jobPath[2] === "activity") return json(res,200,await supervisor.activity(id,z.coerce.number().int().min(0).default(0).parse(url.searchParams.get("after") ?? undefined)));
        if (method === "GET" && jobPath[2] === "trace") {
          const trace = await supervisor.trace(id);
          res.writeHead(200,{ "content-type": "application/x-ndjson; charset=utf-8", "content-disposition": `attachment; filename="${trace.filename}"`,
            "x-laterdog-trace-expires": trace.expiresAt, "x-laterdog-trace-truncated": trace.truncated ? "1" : "0" });
          return void pipeline(trace.stream,res,(error) => { if (error) res.destroy(); });
        }
        if (method === "POST" && jobPath[2] === "screen") return json(res,200,await supervisor.screen(id));
        if (method === "GET" && jobPath[2] === "patch") {
          const job = supervisor.store.job(id); if (!job.patchArtifact) return json(res,404,{ error: "No collected diff" });
          return json(res,200,{ patch: readFileSync(job.patchArtifact,"utf8") });
        }
        if (method === "POST" && jobPath[2] === "action") {
          const body = actionSchema.parse(await readBody(req,120_000));
          const result = body.action === "publish" ? await supervisor.publish(id,body.summary) : body.action === "verify" ? await supervisor.verify(id)
            : body.action === "merge" ? await supervisor.merge(id) : body.action === "cancel" ? await supervisor.stopJob(id,body.acknowledgeUnknown)
            : body.action === "reconcile" ? await supervisor.reconcile(id,body.taskId)
            : body.action === "correct" ? supervisor.correction(id,body.brief,body.requestKey,body.writeScopes) : supervisor.review(id,body.requestKey,body.profileId);
          return json(res,200,result);
        }
      }
      if (url.pathname === "/v1/bridge/devices" && method === "GET") return json(res,200,{ devices: bridge.devices(), requests: bridge.requests() });
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
