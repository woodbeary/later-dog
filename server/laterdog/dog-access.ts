import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createJobSchema, type Job, type WorkspaceSnapshot } from "../../shared/laterdog.ts";
import type { BridgeRequest } from "./bridge-store.ts";
import { desktopSupervisorToken, supervisorOrigin } from "./config.ts";
import { observationSchema } from "./observations.ts";
import type { WorkspaceStore } from "./store.ts";

// A dog (bot) reaches the supervisor through its built-in laterdog MCP server. That server presents the dog's own token,
// derived from the admin token, never the admin token itself, and the token opens only the routes the MCP tools call
// (server/laterdog/mcp.ts), for jobs that dog delegated. The desktop app, `pnpm laterdog:doctor` and the scripts send no
// dog header and keep the admin token's full access.

/** Names the dog a bearer was derived for. A request that sends it must present that dog's token. */
export const DOG_HEADER = "x-laterdog-bot";
/** The bot IDs jobs already carry (createJobSchema.botId). */
const BOT_ID = /^[\w-]{1,100}$/;
const jobId = z.string().uuid();

/**
 * A dog's bearer: base64url(HMAC-SHA256(key = the admin token, message = "laterdog-dog:<botId>")). The supervisor and the
 * Cloudflare Worker (deploy/laterdog/cloudflare/src/dog-token.ts) recompute it from the admin token they already hold, so
 * nothing is stored and rotating the admin token rotates every dog token.
 */
export function dogToken(adminToken: string, botId: string): string {
  return createHmac("sha256", adminToken).update(`laterdog-dog:${botId}`).digest("base64url");
}

export function secretEquals(a: string, b: string): boolean { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x,y); }

function refused(status: 401 | 403, message: string): Error { return Object.assign(new Error(message), { status }); }

/**
 * The dog a request speaks for, or undefined when it names none (then it is the admin token or a paired device). Naming a
 * dog binds the bearer to it: only that dog's derived token passes, never the admin token or another dog's token.
 */
export function authenticateDog(named: string | string[] | undefined, presented: string, adminToken: string): string | undefined {
  if (named === undefined) return undefined;
  if (typeof named === "string" && BOT_ID.test(named) && secretEquals(presented, dogToken(adminToken, named))) return named;
  throw refused(401, "This token is not valid for the dog it names.");
}

/** The built-in laterdog MCP server's environment for one dog (server/index.ts): its own derived token, never the admin token. */
export function dogMcpEnvironment(botId: string, conversationId: string): Record<string, string> {
  return { LATERDOG_SUPERVISOR_URL: supervisorOrigin(), LATERDOG_TOKEN: dogToken(desktopSupervisorToken(), botId),
    LATERDOG_BOT_ID: botId, LATERDOG_CONVERSATION_ID: conversationId };
}

export interface SupervisorCredential { token: string; botId?: string }
/**
 * What the laterdog MCP server presents: the dog's own token when the desktop started it for a dog (LATERDOG_BOT_ID set),
 * otherwise the operator's admin token from this process's configuration. A dog's server never falls back to a token file.
 */
export function mcpCredential(env: NodeJS.ProcessEnv = process.env): SupervisorCredential {
  const botId = env.LATERDOG_BOT_ID?.trim();
  if (!botId) return { token: desktopSupervisorToken() };
  const token = env.LATERDOG_TOKEN?.trim();
  if (!token) throw new Error("This dog has no later.dog token; start a new turn so the desktop can issue one.");
  return { token, botId };
}
export function credentialHeaders(credential: SupervisorCredential): Record<string, string> {
  return { authorization: `Bearer ${credential.token}`, ...(credential.botId ? { [DOG_HEADER]: credential.botId } : {}) };
}

/** Every supervisor route a dog's MCP tools call, and nothing else. `job` marks routes on one job: read it, or act on it. */
const DOG_ROUTES: { method: string; path: RegExp; job?: "read" | "act" }[] = [
  { method: "GET", path: /^\/v1\/workspace$/ }, // laterdog_workspace; jobs filtered to what this dog may read
  { method: "POST", path: /^\/v1\/jobs$/ }, // delegate_cloud_job; owned by this dog
  { method: "GET", path: /^\/v1\/jobs\/([\w-]+)$/, job: "read" }, // inspect_cloud_job
  { method: "GET", path: /^\/v1\/jobs\/([\w-]+)\/patch$/, job: "read" }, // collect_cloud_diff
  { method: "POST", path: /^\/v1\/jobs\/([\w-]+)\/action$/, job: "act" }, // publish/verify/merge/cancel/review/correct_cloud_job, reconcile_cloud_task
  { method: "GET", path: /^\/v1\/profiles\/[a-zA-Z0-9_-]+\/access$/ }, // inspect_provider_access (read-only)
  { method: "GET", path: /^\/v1\/profiles\/[a-zA-Z0-9_-]+\/tasks$/ }, // list_provider_tasks (read-only)
  { method: "POST", path: /^\/v1\/observations$/ }, // record_job_observation; only on this dog's jobs
  { method: "POST", path: /^\/v1\/bridge\/requests$/ }, // request_local_assistance; recorded as this dog's request
  { method: "GET", path: /^\/v1\/bridge\/devices$/ }, // inspect_local_assistance; requests filtered to this dog's
];
/** One plain sentence per refused area, so the dog can tell its person what it cannot do and who can. */
const REFUSALS: [RegExp, string][] = [
  [/^\/v1\/repositories$/, "This dog's access does not include adding or changing repositories; the person connects them in the later.dog Workspace."],
  [/^\/v1\/verification-policy$/, "This dog's access does not include changing a repository's verification checks; the person sets them when connecting the repository in the later.dog Workspace."],
  [/^\/v1\/profiles\/[^/]+\/login$/, "This dog's access does not include starting a provider login; the person runs pnpm laterdog:login."],
  [/^\/v1\/github\//, "This dog's access does not include GitHub sign-in or account details; the person connects GitHub in the later.dog Workspace."],
  [/^\/v1\/bridge\//, "This dog's access does not include pairing, revoking or acting as a paired device."],
  [/^\/v1\/wakeups(?:\/|$)/, "This dog's access does not include the wake-up queue; the later.dog desktop delivers each conversation's wake-ups."],
];
const ELSEWHERE = "This dog's access does not include that later.dog operation.";
const OTHER_DOG = "This dog's access does not include jobs another dog delegated.";
const NOT_DELEGATED = "This dog's access does not include changing a job it did not delegate.";

/** What a caller may reach and see. The admin token's scope changes nothing. */
export interface CallerScope {
  /** The dog this request speaks for; undefined for the admin token. */
  readonly botId?: string;
  /** Throws a 403 with one plain sentence for a route, or a job, outside this caller's access. */
  check(method: string, pathname: string): void;
  snapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot;
  /** A delegation request as this caller may make it. */
  jobRequest(body: unknown): unknown;
  observation(body: unknown): unknown;
  bridgeRequests(requests: BridgeRequest[]): BridgeRequest[];
}
export const ADMIN_SCOPE: CallerScope = { check: () => {}, snapshot: (snapshot) => snapshot, jobRequest: (body) => body, observation: (body) => body, bridgeRequests: (requests) => requests };

/**
 * A dog reads and acts on the jobs it delegated (any of its conversations; corrections and reviews inherit the parent's
 * botId), reads jobs nobody owns (the operator's, or ones made before botId existed) without acting on them, and never sees
 * another dog's jobs or local-assistance results. The provider's own task list (list_provider_tasks) stays account-wide.
 */
export function dogScope(store: WorkspaceStore, botId: string): CallerScope {
  const readable = (job: { botId?: string }) => !job.botId || job.botId === botId;
  const read = (id: string): Job => { const job = store.job(id); if (!readable(job)) throw refused(403,OTHER_DOG); return job; };
  const own = (id: string, refusal = NOT_DELEGATED): Job => { const job = read(id); if (job.botId !== botId) throw refused(403,refusal); return job; };
  return {
    botId,
    check(method, pathname) {
      const route = DOG_ROUTES.find((candidate) => candidate.method === method && candidate.path.test(pathname));
      if (!route) throw refused(403,REFUSALS.find(([path]) => path.test(pathname))?.[1] ?? ELSEWHERE);
      if (!route.job) return;
      const id = jobId.parse(route.path.exec(pathname)?.[1]);
      if (route.job === "read") read(id); else own(id);
    },
    snapshot: (snapshot) => ({ ...snapshot, jobs: snapshot.jobs.filter(readable) }),
    jobRequest(body) {
      const parsed = createJobSchema.safeParse(body);
      if (!parsed.success) return body; // the supervisor reports the validation error itself
      const request = parsed.data;
      if (request.botId !== undefined && request.botId !== botId) throw refused(403,"This dog's access does not include delegating work for another dog.");
      // A repair or review run inherits its parent's branch and pull request, so the parent must be this dog's.
      if (request.parentId) own(request.parentId,"This dog's access does not include repairing or reviewing a job it did not delegate.");
      for (const dependency of request.dependencies) read(dependency);
      return { ...request, botId };
    },
    observation(body) {
      const parsed = observationSchema.safeParse(body);
      if (parsed.success) own(parsed.data.jobId,"This dog's access does not include recording observations on a job it did not delegate.");
      return body;
    },
    bridgeRequests: (requests) => requests.filter((request) => !request.requestedBy || request.requestedBy === botId),
  };
}
