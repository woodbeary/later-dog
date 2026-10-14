import { createHash } from "node:crypto";

const handlersByClass = new Map<string, Record<string, Function>>();

export class ContainerProxy {}

export class WorkerEntrypoint<E> {
  constructor(readonly ctx: unknown, readonly env: E) {}
}

export interface FakeMachine {
  running: boolean;
  starts: number;
  signals: number;
  exit: (() => void) | null;
}

export interface FakeWorld {
  live: Map<string, Set<string>>;
  overlaps: string[];
}

export const world: FakeWorld = { live: new Map(), overlaps: [] };

export function resetWorld(): void {
  world.live.clear();
  world.overlaps.length = 0;
}

export class FakeId {
  constructor(readonly namespace: string, readonly name: string) {}
  toString(): string {
    return createHash("sha256").update(`${this.namespace}:${this.name}`).digest("hex");
  }
  equals(other: FakeId): boolean {
    return other.toString() === this.toString();
  }
}

export class FakeStorage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async deleteAll(): Promise<void> {
    this.values.clear();
  }
}

export function fakeContext(id: FakeId, storage = new FakeStorage()) {
  const machine: FakeMachine = { running: false, starts: 0, signals: 0, exit: null };
  const pending: Promise<unknown>[] = [];
  return {
    id,
    storage,
    pending,
    machine,
    container: {
      get running() {
        return machine.running;
      },
      getTcpPort: () => ({ fetch: async () => Response.json({ app: "laterdog" }) }),
    },
    blockConcurrencyWhile: async (work: () => Promise<unknown>) => {
      const done = work();
      pending.push(done);
      return done;
    },
    waitUntil: (work: Promise<unknown>) => {
      pending.push(work);
    },
  };
}

type Context = ReturnType<typeof fakeContext>;

export class Container<E> {
  static get outboundHandlers(): Record<string, Function> | undefined {
    return handlersByClass.get(this.name);
  }
  static set outboundHandlers(handlers: Record<string, Function>) {
    handlersByClass.set(this.name, { ...handlersByClass.get(this.name), ...handlers });
  }

  defaultPort?: number;
  sleepAfter: string | number = "10m";
  enableInternet = true;
  envVars: Record<string, string> = {};
  outbound: Record<string, { method: string; params?: unknown }> = {};
  schedules = new Map<string, number>();
  status: "stopped" | "running" | "healthy" = "stopped";
  ctx: Context;

  constructor(ctx: Context, readonly env: E) {
    this.ctx = ctx;
  }

  private get machine(): FakeMachine {
    return this.ctx.machine;
  }

  async setOutboundByHost(host: string, method: string, params?: unknown): Promise<void> {
    const handlers = (this.constructor as typeof Container).outboundHandlers;
    if (!handlers?.[method]) throw new Error(`no outbound handler ${method} for ${this.constructor.name}`);
    this.outbound[host] = { method, params };
  }

  async schedule(_when: Date | number, callback: string): Promise<void> {
    this.schedules.set(callback, (this.schedules.get(callback) ?? 0) + 1);
  }

  deleteSchedules(callback: string): void {
    this.schedules.delete(callback);
  }

  async getState(): Promise<{ status: string }> {
    if (!this.machine.running && this.status !== "stopped") this.status = "stopped";
    return { status: this.status };
  }

  async startAndWaitForPorts(..._args: unknown[]): Promise<void> {
    await Promise.resolve();
    if (!this.machine.running) {
      const live = world.live.get(this.ctx.id.name) ?? new Set<string>();
      if (live.size > 0) world.overlaps.push(`${this.ctx.id.namespace} started while ${[...live].join(", ")} was running`);
      live.add(this.ctx.id.namespace);
      world.live.set(this.ctx.id.name, live);
      this.machine.running = true;
      this.machine.starts += 1;
    }
    this.status = "healthy";
  }

  async stop(): Promise<void> {
    if (!this.machine.running) return;
    this.machine.signals += 1;
    this.machine.exit = () => this.exited();
  }

  async destroy(): Promise<void> {
    this.exited();
  }

  private exited(): void {
    this.machine.running = false;
    this.machine.exit = null;
    world.live.get(this.ctx.id.name)?.delete(this.ctx.id.namespace);
    this.status = "stopped";
  }

  async containerFetch(request: Request): Promise<Response> {
    if (!this.machine.running || this.status !== "healthy") {
      try {
        await this.startAndWaitForPorts();
      } catch (error) {
        return new Response(`Failed to start container: ${error instanceof Error ? error.message : String(error)}`, { status: 500 });
      }
    }
    const path = new URL(request.url).pathname;
    if (path === "/api/health") return Response.json({ app: "laterdog" });
    return new Response(`home ${this.ctx.id.namespace} ${path}`);
  }

  async fetch(request: Request): Promise<Response> {
    return this.containerFetch(request);
  }

  renewActivityTimeout(): void {}

  async onActivityExpired(): Promise<void> {
    await this.stop();
  }
}

export class FakeNamespace<T> {
  readonly objects = new Map<string, T>();
  readonly contexts = new Map<string, Context>();
  private build: ((ctx: Context) => T) | null = null;

  constructor(readonly name: string) {}

  bind(build: (ctx: Context) => T): void {
    this.build = build;
  }

  idFromName(name: string): FakeId {
    return new FakeId(this.name, name);
  }

  get(id: FakeId): T {
    const key = id.toString();
    const known = this.objects.get(key);
    if (known) return known;
    if (!this.build) throw new Error("namespace is not bound");
    const ctx = fakeContext(id);
    const object = this.build(ctx);
    this.objects.set(key, object);
    this.contexts.set(key, ctx);
    return object;
  }

  machine(name: string): FakeMachine {
    const ctx = this.contexts.get(this.idFromName(name).toString());
    if (!ctx) throw new Error(`${this.name} has no home ${name}`);
    return ctx.machine;
  }

  async settle(): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
      const pending = [...this.contexts.values()].flatMap((ctx) => ctx.pending.splice(0));
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  }
}
