import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createJobSchema, type Job, type WorkspaceSnapshot } from "../../shared/laterdog.ts";
import { desktopSupervisorToken, supervisorOrigin } from "./config.ts";
import { observationSchema } from "./observations.ts";
import type { WorkspaceStore } from "./store.ts";


export const DOG_HEADER = "x-laterdog-bot";
const BOT_ID = /^[\w-]{1,100}$/;
const jobId = z.string().uuid();

export function dogToken(adminToken: string, botId: string): string {
  return createHmac("sha256", adminToken).update(`laterdog-dog:${botId}`).digest("base64url");
}

export function secretEquals(a: string, b: string): boolean { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x,y); }

function refused(status: 401 | 403, message: string): Error { return Object.assign(new Error(message), { status }); }

export function authenticateDog(named: string | string[] | undefined, presented: string, adminToken: string): string | undefined {
  if (named === undefined) return undefined;
  if (typeof named === "string" && BOT_ID.test(named) && secretEquals(presented, dogToken(adminToken, named))) return named;
  throw refused(401, "This token is not valid for the dog it names.");
}

export function dogMcpEnvironment(botId: string, conversationId: string): Record<string, string> {
  return { LATERDOG_SUPERVISOR_URL: supervisorOrigin(), LATERDOG_TOKEN: dogToken(desktopSupervisorToken(), botId),
    LATERDOG_BOT_ID: botId, LATERDOG_CONVERSATION_ID: conversationId };
}

export function availableDogMcpEnvironment(botId: string, conversationId: string): Record<string, string> | null {
  try { return dogMcpEnvironment(botId, conversationId); } catch { return null; }
}

export interface SupervisorCredential { token: string; botId?: string }
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

const DOG_ROUTES: { method: string; path: RegExp; job?: "read" | "act" }[] = [
  { method: "GET", path: /^\/v1\/workspace$/ },
  { method: "POST", path: /^\/v1\/jobs$/ },
  { method: "GET", path: /^\/v1\/jobs\/([\w-]+)$/, job: "read" },
  { method: "GET", path: /^\/v1\/jobs\/([\w-]+)\/patch$/, job: "read" },
  { method: "POST", path: /^\/v1\/jobs\/([\w-]+)\/action$/, job: "act" },
  { method: "GET", path: /^\/v1\/profiles\/[a-zA-Z0-9_-]+\/access$/ },
  { method: "GET", path: /^\/v1\/profiles\/[a-zA-Z0-9_-]+\/tasks$/ },
  { method: "POST", path: /^\/v1\/observations$/ },
];
const REFUSALS: [RegExp, string][] = [
  [/^\/v1\/repositories$/, "This dog's access does not include adding or changing repositories; the person connects them in the later.dog Workspace."],
  [/^\/v1\/verification-policy$/, "This dog's access does not include changing a repository's verification checks; the person sets them when connecting the repository in the later.dog Workspace."],
  [/^\/v1\/profiles\/[^/]+\/login$/, "This dog's access does not include starting a provider login; the person runs pnpm laterdog:login."],
  [/^\/v1\/github\//, "This dog's access does not include GitHub sign-in or account details; the person connects GitHub in the later.dog Workspace."],
  [/^\/v1\/bridge\//, "This dog's access does not include the person's paired devices."],
  [/^\/v1\/wakeups(?:\/|$)/, "This dog's access does not include the wake-up queue; the later.dog desktop delivers each conversation's wake-ups."],
];
const ELSEWHERE = "This dog's access does not include that later.dog operation.";
const OTHER_DOG = "This dog's access does not include jobs another dog delegated.";
const NOT_DELEGATED = "This dog's access does not include changing a job it did not delegate.";

export interface CallerScope {
  readonly botId?: string;
  check(method: string, pathname: string): void;
  snapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot;
  jobRequest(body: unknown): unknown;
  observation(body: unknown): unknown;
}
export const ADMIN_SCOPE: CallerScope = { check: () => {}, snapshot: (snapshot) => snapshot, jobRequest: (body) => body, observation: (body) => body };

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
      if (!parsed.success) return body;
      const request = parsed.data;
      if (request.botId !== undefined && request.botId !== botId) throw refused(403,"This dog's access does not include delegating work for another dog.");
      if (request.parentId) own(request.parentId,"This dog's access does not include repairing or reviewing a job it did not delegate.");
      for (const dependency of request.dependencies) read(dependency);
      return { ...request, botId };
    },
    observation(body) {
      const parsed = observationSchema.safeParse(body);
      if (parsed.success) own(parsed.data.jobId,"This dog's access does not include recording observations on a job it did not delegate.");
      return body;
    },
  };
}
