// later.dog publishing supervisor on Cloudflare Containers.
//
// One Durable Object ("SupervisorHost") owns one container built from deploy/laterdog/Dockerfile. The Worker in front of it
// checks the supervisor bearer token (or a dog's derived token, for the supervisor API only), forwards everything else
// unchanged, exposes a restart lever, and runs a cron watchdog that revives the container after a host restart. The
// container keeps its state in R2 through the `state.r2` virtual host, so it never holds R2 credentials; see
// deploy/laterdog/entrypoint.sh for the restore/backup side.
import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";
import { DOG_BOT_ID, DOG_HEADER, dogToken } from "./dog-token";
import { WAKEUP_BOTS_HEADER, mayHaveWakeups } from "./wakeup-hint";

export { ContainerProxy };

// Secrets are set with `wrangler secret put` after the first deploy (so they are not declared as required in wrangler.jsonc);
// declare them here so the generated Env type knows about them.
declare global {
  interface Env {
    LATERDOG_TOKEN: string;
    LATERDOG_BACKUP_KEY: string;
    GH_TOKEN?: string;
  }
}

const STATE_HOST = "state.r2";
const STATE_PREFIX = "latest/";
const STATE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const SUPERVISOR_PORT = 9010;

export class SupervisorHost extends Container<Env> {
  defaultPort = SUPERVISOR_PORT;
  // Cost control: the container sleeps after 15 idle minutes. While any job is in flight the cron watchdog pings it every
  // 5 minutes, which resets this timer, so it stays awake exactly as long as there is work and nothing is billed when idle.
  sleepAfter = "15m";
  enableInternet = true;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // Worker secrets become the container's environment at start; a later `wrangler secret put` only reaches a restarted container.
    const envVars: Record<string, string> = {
      LATERDOG_TOKEN: env.LATERDOG_TOKEN,
      LATERDOG_BACKUP_KEY: env.LATERDOG_BACKUP_KEY,
      LATERDOG_STATE_URL: `http://${STATE_HOST}`,
    };
    if (env.GH_TOKEN) envVars.GH_TOKEN = env.GH_TOKEN;
    if (env.LATERDOG_WORKSPACE_URL) envVars.LATERDOG_WORKSPACE_URL = env.LATERDOG_WORKSPACE_URL;
    this.envVars = envVars;
  }

  override onStop(): void {
    console.log("laterdog supervisor container stopped");
  }

  /** Graceful restart lever: SIGTERM lets the entrypoint take a final backup; the next request or cron tick starts a fresh instance. */
  async restart(): Promise<void> {
    console.log("laterdog supervisor: graceful stop requested");
    await this.stop();
  }

  /** Last resort when an instance lingers after a stop (SIGKILL; no final backup). */
  async kill(): Promise<void> {
    console.log("laterdog supervisor: destroy requested");
    await this.destroy();
  }

  /** Durable "work in flight" flag, kept in the Durable Object's own storage so it survives container sleep and host restarts. */
  async markActive(active: boolean): Promise<void> {
    await this.ctx.storage.put("laterdog:active", active);
  }
  async isActive(): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>("laterdog:active")) ?? false;
  }

  /** The supervisor's last report of which dogs have a wake-up waiting (wakeup-hint.ts); kept here so it outlives container sleep. */
  async noteWakeups(report: string): Promise<void> {
    await this.ctx.storage.put("laterdog:wakeup-bots", report);
  }
  async wakeupReport(): Promise<string | undefined> {
    return this.ctx.storage.get<string>("laterdog:wakeup-bots");
  }
}

// Registered through the base class's static setter: a `static outboundByHost = {…}` class field would shadow that setter under
// modern class-field semantics, leaving the handler unregistered and the container's requests to state.r2 unanswered.
SupervisorHost.outboundByHost = {
  [STATE_HOST]: (request: Request, env: Env) => stateHandler(request, env),
};

/** GET/PUT/HEAD http://state.r2/<name> from inside the container, backed by the R2 bucket binding. */
async function stateHandler(request: Request, env: Env): Promise<Response> {
  const name = new URL(request.url).pathname.replace(/^\/+/, "");
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
      // Small files (a SQLite backup, an encrypted token file, an artifacts tar); buffering keeps R2 from needing a declared length.
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

/**
 * The admin bearer, or a dog's token derived for the bot its X-LaterDog-Bot header names. Naming a dog binds the bearer to
 * it: the admin token sent with that header is refused, as the supervisor refuses it.
 */
async function caller(request: Request, env: Env): Promise<"admin" | "dog" | undefined> {
  const presented = request.headers.get("authorization")?.replace(/^Bearer /, "").trim() ?? "";
  const admin = env.LATERDOG_TOKEN.trim();
  const bot = request.headers.get(DOG_HEADER);
  if (bot === null) return (await same(presented, admin)) ? "admin" : undefined;
  return DOG_BOT_ID.test(bot) && (await same(presented, await dogToken(admin, bot))) ? "dog" : undefined;
}

/**
 * Keeps the supervisor's latest wake-up report from any answer that carries one. The report only spares a sleeping container,
 * so failing to keep it (a Durable Object still on older code after a deploy) never fails the answer itself.
 */
async function remember(container: DurableObjectStub<SupervisorHost>, response: Response): Promise<Response> {
  const report = response.headers.get(WAKEUP_BOTS_HEADER);
  if (report !== null) await container.noteWakeups(report).catch((error: unknown) => console.error(`laterdog wake-ups: report not kept: ${String(error)}`));
  return response;
}

/** The last report, or undefined (ask the supervisor) when the Durable Object cannot say. */
async function lastReport(container: DurableObjectStub<SupervisorHost>): Promise<string | undefined> {
  return container.wakeupReport().catch(() => undefined);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/**
 * Keep the container awake only while work is in flight: each ping resets its activity timer and lets the supervisor tick.
 * When the supervisor reports no active jobs the flag is cleared and the container is left to sleep. Also reports an
 * unauthenticated Codex profile loudly in the Worker logs.
 */
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

/** Requests that start or advance work mark the container active so the watchdog keeps it awake until the work settles. */
function startsWork(request: Request, url: URL): boolean {
  return request.method === "POST" && (url.pathname === "/v1/jobs" || /^\/v1\/jobs\/[^/]+\/action$/.test(url.pathname) || /^\/v1\/profiles\/[^/]+\/login$/.test(url.pathname));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    const container = getContainer<SupervisorHost>(env.SUPERVISOR);
    // Paired Mac bridges authenticate with their own device tokens inside the supervisor; everything else needs the admin bearer
    // or a dog's token here.
    if (url.pathname.startsWith("/v1/bridge/")) return container.fetch(request);
    const who = await caller(request, env);
    if (!who) return json({ error: "Valid supervisor token required" }, 401);
    // A dog reaches only the supervisor API, whose own allowlist decides what it may do there; the admin levers stay admin-only.
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
    // The desktop asks for its dogs' wake-ups every half minute. While nothing is in flight and the supervisor last reported none
    // waiting for these dogs, the answer is empty and the container is left asleep; otherwise the supervisor answers.
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
  },
} satisfies ExportedHandler<Env>;
