import { DurableObject } from "cloudflare:workers";
import { within } from "./http";
import { BOX_DESKTOPS, profileKey, validDog } from "./box-routes";

export const BOX_AGENT_PORT = 7070;
export const BOX_INSTANCE = "standard-3";
const RECORD = "box";
const AGENT = ["/usr/bin/tini", "--", "node", "/usr/local/lib/laterdog/box-agent.mjs"];
const AGENT_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 320_000;
const ALWAYS_ON_MS = 5 * 60 * 60_000;
const KEEP_AWAKE_MS = 30_000;
const SAVE_EVERY_MS = 10 * 60_000;
const SAVED_AT = "saved-at";
const SHA256 = /^[0-9a-f]{64}$/;


export interface SavedProfile { dog: string; bytes: number; sha256: string; savedAt: string; from?: string; movedAt?: string }

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
  body: { desktop?: BoxDesktop; profile?: "present" | "restored" | "none"; closed?: boolean; done?: boolean; error?: { code: string; message: string } };
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

  private async agent(path: string, init?: RequestInit, timeoutMs = AGENT_TIMEOUT_MS): Promise<Response | undefined> {
    const container = this.ctx.container;
    if (!container?.running) return undefined;
    try {
      return await within(container.getTcpPort(BOX_AGENT_PORT).fetch(`http://box${path}`, init), timeoutMs);
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

  private person(): string {
    const record = this.record();
    if (!record) throw new Error("The box has not been started.");
    return record.person;
  }

  async save(dog: string): Promise<SavedProfile | undefined> {
    const response = await this.agent(`/profiles/${encodeURIComponent(dog)}`, undefined, RUN_TIMEOUT_MS);
    const bytes = Number(response?.headers.get("content-length"));
    const sha256 = response?.headers.get("x-laterdog-sha256") ?? "";
    if (!response || response.status !== 200 || !response.body || !Number.isSafeInteger(bytes) || !SHA256.test(sha256)) {
      await response?.body?.cancel();
      return undefined;
    }
    const sized = new FixedLengthStream(bytes);
    const piping = response.body.pipeTo(sized.writable);
    const savedAt = new Date().toISOString();
    const key = profileKey(this.person(), dog);
    const moved = (await this.env.BOX_STATE.head(key))?.customMetadata;
    const kept: Record<string, string> = moved?.from && moved.movedAt ? { from: moved.from, movedAt: moved.movedAt } : {};
    await this.env.BOX_STATE.put(key, sized.readable, { sha256, customMetadata: { sha256, savedAt, ...kept } });
    await piping;
    return { dog, bytes, sha256, savedAt };
  }

  async restore(dog: string): Promise<"present" | "restored" | "none" | "refused"> {
    const listed = await this.agent("/profiles");
    const present = listed?.status === 200 ? ((await listed.json()) as { profiles: Array<{ dog: string }> }).profiles.some((profile) => profile.dog === dog) : false;
    if (present) return "present";
    const saved = await this.env.BOX_STATE.get(profileKey(this.person(), dog));
    if (!saved) return "none";
    const sha256 = saved.customMetadata?.sha256 ?? "";
    if (!SHA256.test(sha256)) { await saved.body.cancel(); return "refused"; }
    const sized = new FixedLengthStream(saved.size);
    const piping = saved.body.pipeTo(sized.writable);
    const answer = await this.agent(`/profiles/${encodeURIComponent(dog)}`, { method: "PUT", headers: { "x-laterdog-sha256": sha256, "content-length": String(saved.size) }, body: sized.readable }, RUN_TIMEOUT_MS);
    await piping.catch(() => undefined);
    return answer?.status === 200 ? "restored" : "refused";
  }

  async saved(): Promise<SavedProfile[]> {
    const listed = await this.env.BOX_STATE.list({ prefix: `box/${this.person()}/profiles/`, include: ["customMetadata"] });
    return listed.objects.map((object) => ({ dog: object.key.split("/").pop()!.replace(/\.tgz$/, ""), bytes: object.size, sha256: object.customMetadata?.sha256 ?? "", savedAt: object.customMetadata?.savedAt ?? object.uploaded.toISOString(), ...(object.customMetadata?.from ? { from: object.customMetadata.from } : {}), ...(object.customMetadata?.movedAt ? { movedAt: object.customMetadata.movedAt } : {}) }));
  }

  async open(dog: string): Promise<BoxAnswer | undefined> {
    const restored = await this.restore(dog);
    if (restored === "refused") return { status: 422, body: { error: { code: "profile_refused", message: "The dog's saved profile failed its checksum and was not opened." } } };
    const opened = await this.answer(`/desktops/${encodeURIComponent(dog)}`, { method: "POST" });
    return opened?.body.desktop ? { ...opened, body: { ...opened.body, profile: restored } } : opened;
  }

  async close(dog: string): Promise<BoxAnswer | undefined> {
    const closed = await this.answer(`/desktops/${encodeURIComponent(dog)}`, { method: "DELETE" });
    if (closed?.status === 200) await this.save(dog);
    return closed;
  }

  async run(dog: string, body: unknown): Promise<{ status: number; text: string } | undefined> {
    const call = () => this.agent(`/desktops/${encodeURIComponent(dog)}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, RUN_TIMEOUT_MS);
    let response = await call();
    if (response?.status === 404) {
      await response.body?.cancel();
      const opened = await this.open(dog);
      if (opened?.status !== 200) return opened ? { status: opened.status, text: JSON.stringify(opened.body) } : undefined;
      response = await call();
    }
    return response ? { status: response.status, text: await response.text() } : undefined;
  }

  async input(dog: string, body: unknown): Promise<BoxAnswer | undefined> {
    return this.answer(`/desktops/${encodeURIComponent(dog)}/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
    const status = await this.status();
    const last = this.ctx.storage.kv.get<number>(SAVED_AT) ?? 0;
    if (status && Date.now() - last >= SAVE_EVERY_MS) {
      this.ctx.storage.kv.put(SAVED_AT, Date.now());
      for (const desktop of status.desktops) await this.save(desktop.dog).catch(() => undefined);
    }
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
