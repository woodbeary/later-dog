import { DurableObject } from "cloudflare:workers";
import { within } from "./http";
import { BOX_DESKTOPS, validDog } from "./box-routes";

export const BOX_AGENT_PORT = 7070;
export const BOX_INSTANCE = "standard-3";
const RECORD = "box";
const AGENT = ["/usr/bin/tini", "--", "node", "/usr/local/lib/laterdog/box-agent.mjs"];
const AGENT_TIMEOUT_MS = 15_000;
const ALWAYS_ON_MS = 5 * 60 * 60_000;
const KEEP_AWAKE_MS = 30_000;

interface BoxRecord {
  person: string;
  generation: number;
  startedAt: number;
}

export interface BoxDesktop {
  dog: string;
  display: number;
  viewerPort: number;
  openedAt: number;
  idleMs: number;
  restarts: number;
}

export interface BoxStatus {
  box: { uptimeMs: number; maxDesktops: number; idleMs: number; memory: { totalBytes: number; availableBytes: number } | null };
  desktops: BoxDesktop[];
}

export interface BoxAnswer {
  status: number;
  body: { desktop?: BoxDesktop; closed?: boolean; error?: { code: string; message: string } };
}

export class PersonalBox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (!container?.running) return;
    void ctx.blockConcurrencyWhile(async () => {
      try {
        await container.setInactivityTimeout(ALWAYS_ON_MS);
      } catch (error) {
        console.error(`laterdog computers: [box] could not re-arm the inactivity timeout: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  private record(): BoxRecord | undefined {
    return this.ctx.storage.kv.get<BoxRecord>(RECORD);
  }

  private container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("This Durable Object has no container; check the containers entry in wrangler.jsonc.");
    return container;
  }

  async ensure(person: string): Promise<{ started: boolean; generation: number }> {
    const container = this.container();
    const record = this.record() ?? { person, generation: 0, startedAt: Date.now() };
    if (container.running) {
      this.ctx.storage.kv.put(RECORD, record);
      return { started: false, generation: record.generation };
    }
    const image = container.images.box;
    if (!image) throw new Error('No "box" image is configured for this Worker.');
    const next = { ...record, person, generation: record.generation + 1, startedAt: Date.now() };
    this.ctx.storage.kv.put(RECORD, next);
    container.start({
      image,
      instance: BOX_INSTANCE,
      enableInternet: true,
      entrypoint: AGENT,
      env: { LATERDOG_BOX_PORT: String(BOX_AGENT_PORT), LATERDOG_BOX_DESKTOPS: String(BOX_DESKTOPS) },
      labels: { box: person, generation: String(next.generation) },
    });
    await container.setInactivityTimeout(ALWAYS_ON_MS);
    const started = Date.now();
    void Promise.resolve().then(() => container.monitor()).then(
      () => console.error(`laterdog computers: [box] generation ${next.generation} stopped after ${Date.now() - started} ms`),
      (error: unknown) => console.error(`laterdog computers: [box] generation ${next.generation} failed after ${Date.now() - started} ms: ${error instanceof Error ? error.message : String(error)}`),
    );
    console.log(`laterdog computers: [box] start generation ${next.generation}`);
    await this.ctx.storage.setAlarm(Date.now() + KEEP_AWAKE_MS);
    return { started: true, generation: next.generation };
  }

  private async agent(path: string, init?: RequestInit): Promise<Response | undefined> {
    const container = this.ctx.container;
    if (!container?.running) return undefined;
    try {
      return await within(container.getTcpPort(BOX_AGENT_PORT).fetch(`http://box${path}`, init), AGENT_TIMEOUT_MS);
    } catch {
      return undefined;
    }
  }

  private async answer(path: string, init?: RequestInit): Promise<BoxAnswer | undefined> {
    const response = await this.agent(path, init);
    if (!response) return undefined;
    return { status: response.status, body: (await response.json()) as BoxAnswer["body"] };
  }

  async status(): Promise<BoxStatus | undefined> {
    const response = await this.agent("/status");
    return response?.status === 200 ? ((await response.json()) as BoxStatus) : undefined;
  }

  async open(dog: string): Promise<BoxAnswer | undefined> {
    return this.answer(`/desktops/${encodeURIComponent(dog)}`, { method: "POST" });
  }

  async close(dog: string): Promise<BoxAnswer | undefined> {
    return this.answer(`/desktops/${encodeURIComponent(dog)}`, { method: "DELETE" });
  }

  async screenshot(dog: string): Promise<{ status: number; png?: ArrayBuffer; body?: BoxAnswer["body"] } | undefined> {
    const response = await this.agent(`/desktops/${encodeURIComponent(dog)}/screenshot`);
    if (!response) return undefined;
    if (response.status === 200) return { status: 200, png: await response.arrayBuffer() };
    return { status: response.status, body: (await response.json()) as BoxAnswer["body"] };
  }

  async stop(): Promise<void> {
    if (this.ctx.container?.running) await this.ctx.container.destroy().catch(() => undefined);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    console.log("laterdog computers: [box] removed");
  }

  override async alarm(): Promise<void> {
    if (!this.record() || !this.ctx.container?.running) return;
    await this.status();
    await this.ctx.storage.setAlarm(Date.now() + KEEP_AWAKE_MS);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const dog = url.searchParams.get("dog") ?? "";
    const container = this.ctx.container;
    if (!validDog(dog) || !container?.running) return Response.json({ error: { code: "no_desktop", message: "This dog has no desktop open." } }, { status: 404 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade.", { status: 426 });
    const desktop = (await this.status())?.desktops.find((candidate) => candidate.dog === dog);
    if (!desktop) return Response.json({ error: { code: "no_desktop", message: "This dog has no desktop open." } }, { status: 404 });
    await this.agent(`/desktops/${encodeURIComponent(dog)}/touch`, { method: "POST" });
    return container.getTcpPort(desktop.viewerPort).fetch("http://box/websockify", { headers: request.headers });
  }
}
