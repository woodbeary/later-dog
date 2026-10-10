import { vi } from "vitest";
import { sha256Hex } from "../src/auth";
import worker, { ComputerRegistry, DogComputer, TrialRegistry } from "../src/index";

const sqliteModule = "node:sqlite";
const { DatabaseSync } = await import(sqliteModule);

export const T0 = Date.UTC(2026, 9, 10, 12);
export const HOST = "computers.example";
export const ORIGIN = `https://${HOST}`;
export const OWNER_KEY = "ldc_owner-key-for-tests";
export const IP = "203.0.113.7";

export const VARS: Record<string, string> = {
  MAX_COMPUTERS: "10",
  IDLE_SLEEP_MINUTES: "15",
  MAX_AWAKE_HOURS: "8",
  TRIALS_ENABLED: "true",
  TRIAL_MINUTES: "30",
  TRIAL_DAYS: "7",
  TRIALS_PER_DAY: "20",
  TRIAL_IDLE_SLEEP_MINUTES: "5",
  TRIAL_COUNTRIES: "",
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  TURNSTILE_SECRET_KEY: "turnstile-secret-for-tests",
  TRIAL_NETWORK_KEY: "network-key-for-tests",
  DESKTOP_SIGNING_KEY: "desktop-signing-key-for-tests",
};

type Row = Record<string, unknown>;

export interface Slot {
  alarm: number | null;
  fire: () => Promise<void>;
}

function sqlStorage() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows: Row[] = db.prepare(query).all(...bindings);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}.`);
          return rows[0];
        },
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  };
}

export class FakeContainer {
  running = false;
  failSnapshot = false;
  snapshots = 0;
  readonly starts: unknown[] = [];
  readonly images = { desktop: "laterdog-desktop:test" };

  start(options: unknown): void {
    this.starts.push(options);
    this.running = true;
  }

  async destroy(): Promise<void> {
    this.running = false;
  }

  async setInactivityTimeout(): Promise<void> {
    await Promise.resolve();
  }

  async snapshotContainer(options: { name: string }): Promise<{ id: string; size: number; name: string }> {
    if (this.failSnapshot) throw new Error("The snapshot service is busy.");
    this.snapshots += 1;
    return { id: `snapshot-${this.snapshots}`, size: 4096, name: options.name };
  }

  async exec(): Promise<{ exitCode: Promise<number>; stdout: null; stderr: null; kill(): void }> {
    return { exitCode: Promise.resolve(0), stdout: null, stderr: null, kill: () => undefined };
  }

  getTcpPort(): { fetch(): Promise<Response> } {
    return { fetch: async () => new Response("{}") };
  }
}

function fakeState(slot: Slot, container?: FakeContainer): DurableObjectState {
  const values = new Map<string, unknown>();
  const storage = {
    sql: sqlStorage(),
    kv: {
      get: (key: string) => (values.has(key) ? structuredClone(values.get(key)) : undefined),
      put: (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      },
    },
    getAlarm: async () => slot.alarm,
    setAlarm: async (at: number | Date) => {
      slot.alarm = typeof at === "number" ? at : at.getTime();
    },
    deleteAlarm: async () => {
      slot.alarm = null;
    },
    deleteAll: async () => {
      values.clear();
      slot.alarm = null;
    },
  };
  const state = { storage, container, blockConcurrencyWhile: async <T>(work: () => Promise<T>) => work() };
  return state as unknown as DurableObjectState;
}

function rpc<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key, object);
      if (typeof value !== "function") return value;
      if (key === "fetch") return value.bind(object);
      return async (...args: unknown[]) => structuredClone(await value.apply(object, structuredClone(args)));
    },
  });
}

export class FakeNamespace<T extends object> {
  readonly instances = new Map<string, T>();
  readonly slots = new Map<string, Slot>();

  constructor(
    private readonly alarms: Slot[],
    private readonly make: (name: string, slot: Slot) => T,
  ) {}

  idFromName(name: string): { name: string } {
    return { name };
  }

  get(id: { name: string }): T {
    let instance = this.instances.get(id.name);
    if (!instance) {
      const slot: Slot = { alarm: null, fire: async () => undefined };
      this.alarms.push(slot);
      this.slots.set(id.name, slot);
      instance = this.make(id.name, slot);
      this.instances.set(id.name, instance);
    }
    return rpc(instance);
  }

  named(name: string): T {
    return this.get(this.idFromName(name));
  }
}

export async function world(vars: Record<string, string> = {}) {
  const clock = { now: T0 };
  vi.spyOn(Date, "now").mockImplementation(() => clock.now);
  const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const alarms: Slot[] = [];
  const containers = new Map<string, FakeContainer>();
  const env: Record<string, unknown> = { ...VARS, COMPUTERS_KEY_SHA256: await sha256Hex(OWNER_KEY), ...vars };
  const typed = env as unknown as Env;
  const computers = new FakeNamespace(alarms, (name, slot) => {
    const container = new FakeContainer();
    containers.set(name, container);
    const instance = new DogComputer(fakeState(slot, container), typed);
    slot.fire = () => instance.alarm();
    return instance;
  });
  const registries = new FakeNamespace(alarms, (_name, slot) => new ComputerRegistry(fakeState(slot), typed));
  const trials = new FakeNamespace(alarms, (_name, slot) => {
    const instance = new TrialRegistry(fakeState(slot), typed);
    slot.fire = () => instance.alarm();
    return instance;
  });
  Object.assign(env, { COMPUTER: computers, REGISTRY: registries, TRIALS: trials });

  return {
    env,
    clock,
    logs,
    errors,
    containers,
    computers,
    registries,
    trials,
    fetch: (request: Request) => worker.fetch(request, typed),
    async advance(ms: number): Promise<void> {
      const until = clock.now + ms;
      for (let fired = 0; ; fired++) {
        if (fired > 10_000) throw new Error("The alarms never settled.");
        let next: Slot | undefined;
        for (const slot of alarms) {
          if (slot.alarm !== null && slot.alarm <= until && (next === undefined || slot.alarm < next.alarm!)) next = slot;
        }
        if (!next) break;
        clock.now = Math.max(clock.now, next.alarm!);
        next.alarm = null;
        await next.fire();
      }
      clock.now = until;
    },
  };
}

export type World = Awaited<ReturnType<typeof world>>;

export function apiRequest(method: string, path: string, key: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, ...options.headers };
  if (options.body === undefined) return new Request(`${ORIGIN}${path}`, { method, headers });
  return new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(options.body) });
}

export function trialForm(fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/trial`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": IP, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

export function siteverify() {
  const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (_url, init) => {
    const token = new URLSearchParams(String(init?.body ?? "")).get("response") ?? "";
    if (token === "down") return new Response("unavailable", { status: 503 });
    return Response.json({ success: token.startsWith("pass:"), hostname: HOST, action: "trial", cdata: token.slice("pass:".length) });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

export function trialKey(fill: string): string {
  return `ldt_${fill.repeat(43).slice(0, 43)}`;
}

export async function startTrial(w: World, key: string, ip = IP): Promise<Response> {
  const claim = await sha256Hex(key);
  return w.fetch(trialForm({ claim, "cf-turnstile-response": `pass:${claim}` }, { "cf-connecting-ip": ip }));
}

export async function body(response: Response): Promise<any> {
  return response.json();
}
