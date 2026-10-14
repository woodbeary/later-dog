import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";
import { DOG_BOT_ID, DOG_HEADER, dogToken } from "./dog-token";
import { WAKEUP_BOTS_HEADER, mayHaveWakeups } from "./wakeup-hint";
import { TRACE_PREFIX, handleTrace, sweepDue, sweepTraces } from "./traces";

export { ContainerProxy };

declare global {
  interface Env {
    LATERDOG_TOKEN: string;
    LATERDOG_BACKUP_KEY: string;
    GH_TOKEN?: string;
    CLAUDE_CODE_OAUTH_TOKEN?: string;
    LATERDOG_COMPUTERS_PUBLIC_URL?: string;
  }
}

const STATE_HOST = "state.r2";
const COMPUTERS_HOST = "computers.internal";
const STATE_PREFIX = "latest/";
const STATE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const SUPERVISOR_PORT = 9010;
const CLAUDE_ACCOUNT_TOKEN = /^CLAUDE_CODE_OAUTH_TOKEN_[A-Z0-9_]+$/;

export class SupervisorHost extends Container<Env> {
  defaultPort = SUPERVISOR_PORT;
  sleepAfter = "15m";
  enableInternet = true;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const envVars: Record<string, string> = {
      LATERDOG_TOKEN: env.LATERDOG_TOKEN,
      LATERDOG_BACKUP_KEY: env.LATERDOG_BACKUP_KEY,
      LATERDOG_STATE_URL: `http://${STATE_HOST}`,
    };
    if (env.GH_TOKEN) envVars.GH_TOKEN = env.GH_TOKEN;
    if (env.CLAUDE_CODE_OAUTH_TOKEN) envVars.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN;
    if (env.LATERDOG_WORKSPACE_URL) envVars.LATERDOG_WORKSPACE_URL = env.LATERDOG_WORKSPACE_URL;
    if (env.TRACE_RETENTION_DAYS) envVars.LATERDOG_TRACE_RETENTION_DAYS = env.TRACE_RETENTION_DAYS;
    for (const [name, value] of Object.entries(env as unknown as Record<string, unknown>)) {
      if (CLAUDE_ACCOUNT_TOKEN.test(name) && typeof value === "string") envVars[name] = value;
    }
    this.envVars = envVars;
  }

  override onStop(): void {
    console.log("laterdog supervisor container stopped");
  }

  async restart(): Promise<void> {
    console.log("laterdog supervisor: graceful stop requested");
    await this.stop();
  }

  async kill(): Promise<void> {
    console.log("laterdog supervisor: destroy requested");
    await this.destroy();
  }

  async markActive(active: boolean): Promise<void> {
    await this.ctx.storage.put("laterdog:active", active);
  }
  async isActive(): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>("laterdog:active")) ?? false;
  }

  async noteWakeups(report: string): Promise<void> {
    await this.ctx.storage.put("laterdog:wakeup-bots", report);
  }
  async wakeupReport(): Promise<string | undefined> {
    return this.ctx.storage.get<string>("laterdog:wakeup-bots");
  }
}

SupervisorHost.outboundByHost = {
  [STATE_HOST]: (request: Request, env: Env) => stateHandler(request, env),
  [COMPUTERS_HOST]: (request: Request, env: Env) => computersHandler(request, env),
};

async function computersHandler(request: Request, env: Env): Promise<Response> {
  if (!env?.COMPUTERS) {
    return Response.json({ error: { code: "not_configured", message: "The supervisor Worker has no COMPUTERS service binding to the laterdog-computers Worker" } }, { status: 503 });
  }
  try {
    const incoming = new URL(request.url);
    const publicUrl = env.LATERDOG_COMPUTERS_PUBLIC_URL?.trim();
    const target = publicUrl ? `${new URL(publicUrl).origin}${incoming.pathname}${incoming.search}` : request.url;
    const headers = new Headers(request.headers);
    headers.delete("origin");
    const body = request.method === "GET" || request.method === "HEAD" ? null : request.body;
    return await env.COMPUTERS.fetch(new Request(target, { method: request.method, headers, body, redirect: "manual" }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`laterdog computers: ${request.method} ${new URL(request.url).pathname} failed: ${message}`);
    return Response.json({ error: { code: "container_error", message: "The laterdog-computers Worker could not be reached through its service binding" } }, { status: 502 });
  }
}

async function traceHandler(request: Request, env: Env, key: string): Promise<Response> {
  try {
    if (!env?.STATE) throw new Error("R2 binding STATE is not available to the outbound handler");
    const response = await handleTrace(request, env.STATE as unknown as Parameters<typeof handleTrace>[1], key, { configuredDays: env.TRACE_RETENTION_DAYS });
    if (request.method === "PUT") console.log(`laterdog traces: ${key} answered ${response.status}`);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`laterdog traces: ${request.method} ${key} failed: ${message}`);
    return new Response(`Trace store error: ${message}`, { status: 500 });
  }
}

async function stateHandler(request: Request, env: Env): Promise<Response> {
  const name = new URL(request.url).pathname.replace(/^\/+/, "");
  if (name.startsWith(TRACE_PREFIX)) return traceHandler(request, env, name);
  if (!STATE_KEY.test(name)) return new Response("Invalid state key", { status: 400 });
  const key = `${STATE_PREFIX}${name}`;
  try {
    if (!env?.STATE) throw new Error("R2 binding STATE is not available to the outbound handler");
    if (request.method === "HEAD") return new Response(null, { status: (await env.STATE.head(key)) ? 200 : 404 });
    if (request.method === "GET") {
      const object = await env.STATE.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      return new Response(object.body, { headers: { "content-type": "application/octet-stream", etag: object.httpEtag } });
    }
    if (request.method === "PUT") {
      const body = await request.arrayBuffer();
      await env.STATE.put(key, body, { httpMetadata: { contentType: "application/octet-stream" } });
      console.log(`laterdog state: stored ${name} (${body.byteLength} bytes)`);
      return new Response("Stored", { status: 201 });
    }
    return new Response("Method not allowed", { status: 405 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`laterdog state: ${request.method} ${name} failed: ${message}`);
    return new Response(`State store error: ${message}`, { status: 500 });
  }
}

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

async function same(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function caller(request: Request, env: Env): Promise<"admin" | "dog" | undefined> {
  const presented = request.headers.get("authorization")?.replace(/^Bearer /, "").trim() ?? "";
  const admin = env.LATERDOG_TOKEN.trim();
  if (admin.length < 32) return undefined;
  const bot = request.headers.get(DOG_HEADER);
  if (bot === null) return (await same(presented, admin)) ? "admin" : undefined;
  return DOG_BOT_ID.test(bot) && (await same(presented, await dogToken(admin, bot))) ? "dog" : undefined;
}

async function remember(container: DurableObjectStub<SupervisorHost>, response: Response): Promise<Response> {
  const report = response.headers.get(WAKEUP_BOTS_HEADER);
  if (report !== null) await container.noteWakeups(report).catch((error: unknown) => console.error(`laterdog wake-ups: report not kept: ${String(error)}`));
  return response;
}

async function lastReport(container: DurableObjectStub<SupervisorHost>): Promise<string | undefined> {
  return container.wakeupReport().catch(() => undefined);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

async function watchdog(env: Env): Promise<void> {
  const container = getContainer<SupervisorHost>(env.SUPERVISOR);
  if (!(await container.isActive())) return;
  const headers = { authorization: `Bearer ${env.LATERDOG_TOKEN.trim()}` };
  const workspace = await remember(container, await container.fetch(new Request("https://laterdog-supervisor/v1/workspace", { headers })));
  if (!workspace.ok) {
    console.error(`laterdog watchdog: supervisor returned ${workspace.status}`);
    return;
  }
  const snapshot = (await workspace.json().catch(() => null)) as { active?: number } | null;
  if (snapshot && snapshot.active === 0) {
    await container.markActive(false);
    console.log("laterdog watchdog: no active jobs; the container may sleep");
  }
  const access = await container.fetch(new Request("https://laterdog-supervisor/v1/profiles/default/access", { headers }));
  const report = (await access.json().catch(() => null)) as { authenticated?: boolean } | null;
  if (!report?.authenticated) console.error("laterdog watchdog: the Codex profile is not authenticated; run `pnpm laterdog:login` against this supervisor");
}

function startsWork(request: Request, url: URL): boolean {
  return request.method === "POST" && (url.pathname === "/v1/jobs" || /^\/v1\/jobs\/[^/]+\/action$/.test(url.pathname) || /^\/v1\/profiles\/[^/]+\/login$/.test(url.pathname));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    const container = getContainer<SupervisorHost>(env.SUPERVISOR);
    if (url.pathname.startsWith("/v1/bridge/")) return container.fetch(request);
    const who = await caller(request, env);
    if (!who) return json({ error: "Valid supervisor token required" }, 401);
    if (who === "dog" && !url.pathname.startsWith("/v1/")) return json({ error: "This dog's access does not include administering the hosted supervisor." }, 403);
    if (url.pathname === "/admin/restart" && request.method === "POST") {
      await container.restart();
      return json({ restarting: true, note: "The entrypoint takes a final backup on SIGTERM; the next request or cron tick starts a fresh instance that restores it." }, 202);
    }
    if (url.pathname === "/admin/destroy" && request.method === "POST") {
      await container.kill();
      return json({ destroyed: true, note: "SIGKILL; state since the last backup is lost. Use /admin/restart for a graceful stop." }, 202);
    }
    if (url.pathname === "/admin/wake" && request.method === "POST") {
      await container.markActive(true);
      const probe = await container.fetch(new Request("https://laterdog-supervisor/v1/workspace", { headers: { authorization: request.headers.get("authorization") ?? "" } }));
      return json({ awake: probe.ok, status: probe.status }, probe.ok ? 200 : 502);
    }
    if (who === "admin" && url.pathname === "/v1/wakeups/pull" && request.method === "POST") {
      const body = await request.text();
      if (!(await container.isActive()) && !mayHaveWakeups(await lastReport(container), body)) return json({ wakeups: [] });
      return remember(container, await container.fetch(new Request(request.url, { method: "POST", headers: request.headers, body })));
    }
    if (startsWork(request, url)) await container.markActive(true);
    return remember(container, await container.fetch(request));
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(watchdog(env));
    if (sweepDue(Date.now())) {
      ctx.waitUntil(sweepTraces(env.STATE as unknown as Parameters<typeof sweepTraces>[0], Date.now())
        .then((removed) => { if (removed) console.log(`laterdog traces: removed ${removed} expired`); })
        .catch((error: unknown) => console.error(`laterdog traces: sweep failed: ${String(error)}`)));
    }
  },
} satisfies ExportedHandler<Env>;
