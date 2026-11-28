import { DurableObject } from "cloudflare:workers";
import { AGENT_PORT, type EngineSpec, type HostLoad, POOL_INSTANCE } from "./pool-policy";
import { within } from "./http";

const RECORD = "pool-host";
const AGENT = "/usr/local/bin/laterdog-pool-agent";
const AGENT_TIMEOUT_MS = 10_000;
const ALWAYS_ON_MS = 5 * 60 * 60_000;
export const KEEP_AWAKE_MS = 10_000;

interface HostRecord {
  id: string;
  home: string;
  generation: number;
  startedAt: number;
}

export interface EngineView {
  chat: string;
  warm: boolean;
  pid: number;
  slot: number;
  startMs: number;
  memoryBytes: number;
  reuses: number;
  evicted: string[];
}

export interface AgentAnswer {
  status: number;
  body: { engine?: EngineView; error?: { code: string; message: string }; closed?: string };
}

export interface AgentEngine {
  chat: string;
  attached: boolean;
  memoryBytes: number;
}

export interface AgentStatus {
  host: { limitBytes: number; usedBytes: number; budgetBytes: number; estimateBytes: number; cpuShare?: number };
  agent: { residentBytes: number; uptimeMs: number };
  engines: AgentEngine[];
  evictions: unknown[];
}

export function loadFrom(status: AgentStatus): HostLoad {
  return {
    limitBytes: status.host.limitBytes,
    usedBytes: status.host.usedBytes,
    budgetBytes: status.host.budgetBytes,
    estimateBytes: status.host.estimateBytes,
    engines: status.engines.length,
    busy: status.engines.filter((engine) => engine.attached).length,
    warm: status.engines.map((engine) => engine.chat),
    ...(status.host.cpuShare === undefined ? {} : { cpuShare: status.host.cpuShare }),
  };
}

export function agentEnv(env: Env): Record<string, string> {
  const pairs: Array<[string, string | undefined]> = [
    ["LATERDOG_POOL_IDLE_SECONDS", env.POOL_IDLE_SECONDS],
    ["LATERDOG_POOL_BUDGET_PERCENT", env.POOL_BUDGET_PERCENT],
  ];
  return Object.fromEntries(pairs.filter((pair): pair is [string, string] => typeof pair[1] === "string" && /^\d{1,6}$/.test(pair[1])));
}

export class PoolHost extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (!container?.running) return;
    void ctx.blockConcurrencyWhile(async () => {
      try {
        await container.setInactivityTimeout(ALWAYS_ON_MS);
      } catch (error) {
        console.error(`laterdog computers: [pool] could not re-arm the inactivity timeout: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  private load(): HostRecord | undefined {
    return this.ctx.storage.kv.get<HostRecord>(RECORD);
  }

  private container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("This Durable Object has no container; check the containers entry in wrangler.jsonc.");
    return container;
  }

  async ensure(input: { id: string; home: string }): Promise<{ started: boolean; generation: number }> {
    const container = this.container();
    const record = this.load() ?? { id: input.id, home: input.home, generation: 0, startedAt: Date.now() };
    if (container.running) {
      this.ctx.storage.kv.put(RECORD, record);
      return { started: false, generation: record.generation };
    }
    const image = container.images.pool;
    if (!image) throw new Error('No "pool" image is configured for this Worker.');
    const next = { ...record, generation: record.generation + 1, startedAt: Date.now() };
    this.ctx.storage.kv.put(RECORD, next);
    container.start({
      image,
      instance: POOL_INSTANCE,
      enableInternet: true,
      entrypoint: [AGENT, "serve"],
      env: { LATERDOG_POOL_HOST: next.id, ...agentEnv(this.env) },
      labels: { pool: next.id, generation: String(next.generation) },
    });
    await container.setInactivityTimeout(ALWAYS_ON_MS);
    const started = Date.now();
    void Promise.resolve().then(() => container.monitor()).then(
      () => console.error(`laterdog computers: [pool] ${next.id} generation ${next.generation} stopped after ${Date.now() - started} ms`),
      (error: unknown) => console.error(`laterdog computers: [pool] ${next.id} generation ${next.generation} failed after ${Date.now() - started} ms: ${error instanceof Error ? error.message : String(error)}`),
    );
    console.log(`laterdog computers: [pool] start ${next.id} (generation ${next.generation}, ${POOL_INSTANCE})`);
    await this.ctx.storage.setAlarm(Date.now() + KEEP_AWAKE_MS);
    return { started: true, generation: next.generation };
  }

  private async agent(path: string, init?: RequestInit): Promise<AgentAnswer | undefined> {
    const container = this.ctx.container;
    if (!container?.running) return undefined;
    try {
      const response = await within(container.getTcpPort(AGENT_PORT).fetch(`http://pool${path}`, init), AGENT_TIMEOUT_MS);
      if (!response) return undefined;
      return { status: response.status, body: (await response.json()) as AgentAnswer["body"] };
    } catch {
      return undefined;
    }
  }

  async status(): Promise<AgentStatus | undefined> {
    const container = this.ctx.container;
    if (!container?.running) return undefined;
    try {
      const response = await within(container.getTcpPort(AGENT_PORT).fetch("http://pool/status"), AGENT_TIMEOUT_MS);
      return response?.status === 200 ? ((await response.json()) as AgentStatus) : undefined;
    } catch {
      return undefined;
    }
  }

  async open(spec: EngineSpec): Promise<AgentAnswer | undefined> {
    return this.agent("/engines", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec) });
  }

  async close(chat: string): Promise<AgentAnswer | undefined> {
    return this.agent(`/engines/${encodeURIComponent(chat)}`, { method: "DELETE" });
  }

  async remove(): Promise<void> {
    const record = this.load();
    if (this.ctx.container?.running) await this.ctx.container.destroy().catch(() => undefined);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    console.log(`laterdog computers: [pool] removed ${record?.id ?? "a host"}`);
  }

  override async alarm(): Promise<void> {
    if (!this.load() || !this.ctx.container?.running) return;
    await this.status();
    await this.ctx.storage.setAlarm(Date.now() + KEEP_AWAKE_MS);
  }

  override async fetch(request: Request): Promise<Response> {
    const chat = new URL(request.url).searchParams.get("chat");
    const container = this.ctx.container;
    if (!chat || !container?.running) return Response.json({ error: { code: "not_warm", message: "No warm engine for that chat." } }, { status: 404 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade.", { status: 426 });
    return container.getTcpPort(AGENT_PORT).fetch(`http://pool/engines/${encodeURIComponent(chat)}/stream`, { headers: request.headers });
  }
}
