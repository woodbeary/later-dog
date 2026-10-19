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
  sessions: Set<string>;
  hooks: Set<string>;
  sessionChecks: number;
}

export const world: FakeWorld = { live: new Map(), overlaps: [], sessions: new Set(), hooks: new Set(), sessionChecks: 0 };

export function resetWorld(): void {
  world.live.clear();
  world.overlaps.length = 0;
  world.sessions.clear();
  world.hooks.clear();
  world.sessionChecks = 0;
}

function presentedSession(request: Request): string | undefined {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (bearer) return bearer;
  return /laterdog_session_[^=]*=([^;\s]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
}

function homeAnswer(namespace: string, request: Request): Response {
  const path = new URL(request.url).pathname;
  if (path === "/api/health") return Response.json({ app: "laterdog" });
  if (path === "/api/auth/session") {
    world.sessionChecks += 1;
    const token = presentedSession(request);
    return token && world.sessions.has(token) ? Response.json({ kind: "session", scopes: ["admin", "client"] }) : Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (path === "/api/cloud/pairing") return Response.json({ code: "ABCD-EFGH-JKMN", credential: `laterdog_pair_${"p".repeat(43)}`, expiresAt: Date.now() + 120_000 });
  if (path.startsWith("/hooks/")) return world.hooks.has(path) ? Response.json({ accepted: true }, { status: 202 }) : Response.json({ error: "Invalid webhook URL or secret" }, { status: 401 });
  return new Response(`home ${namespace} ${path}`);
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
  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
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
      getTcpPort: () => ({ fetch: async (url: string, init: Request) => homeAnswer(id.namespace, new Request(url, init)) }),
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
    return homeAnswer(this.ctx.id.namespace, request);
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
