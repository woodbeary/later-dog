import { DurableObject } from "cloudflare:workers";
import type { Refusal } from "./auth";
import type { AgentStatus, EngineView, PoolHost } from "./pool-host";
import { loadFrom } from "./pool-host";
import {
  CHECK_MS,
  type EngineSpec,
  type HostLoad,
  type PoolHostRecord,
  type PoolSettings,
  START_PATIENCE_MS,
  hourlyCost,
  nearlyFull,
  hostHourlyUsd,
  observe,
  place,
  planScale,
  poolSettings,
} from "./pool-policy";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const WAIT_STEP_MS = 500;
const MISSED_CHECKS_BEFORE_RESTART = 3;

type HostRow = {
  id: string;
  state: string;
  started_at: number;
  ready_at: number | null;
  checked_at: number | null;
  load: string | null;
  high_since: number | null;
  low_since: number | null;
  missed: number;
};

export type MachineFace = "waking" | "live" | "parking";

export interface OpenedEngine {
  chat: string;
  host: string;
  state: "warm" | "cold" | "waking";
  sticky: boolean;
  placeMs: number;
  engine?: EngineView;
  scaledOut: boolean;
  stream: string;
}

export interface Opened {
  value?: OpenedEngine;
  refusal?: Refusal;
}

export function faceOf(state: PoolHostRecord["state"]): MachineFace {
  return state === "starting" ? "waking" : state === "ready" ? "live" : "parking";
}

export interface PoolView {
  settings: PoolSettings;
  hosts: Array<{ id: string; state: string; face: MachineFace; startedAt: string; readyAt?: string; bootMs?: number; load?: HostLoad; hourlyUsd: number }>;
  chats: number;
  hourlyUsd: number;
  agents?: Record<string, AgentStatus | null>;
}

function hostFrom(row: HostRow): PoolHostRecord {
  return {
    id: row.id,
    state: row.state as PoolHostRecord["state"],
    startedAt: row.started_at,
    ...(row.ready_at === null ? {} : { readyAt: row.ready_at }),
    ...(row.checked_at === null ? {} : { checkedAt: row.checked_at }),
    ...(row.load === null ? {} : { load: JSON.parse(row.load) as HostLoad }),
    ...(row.high_since === null ? {} : { highSince: row.high_since }),
    ...(row.low_since === null ? {} : { lowSince: row.low_since }),
  };
}

function newHostId(): string {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(12))) id += BASE32[byte & 31];
  return `pool_${id}`;
}

export const streamPath = (chat: string) => `/v1/pool/engines/${chat}/stream`;
const iso = (at: number) => new Date(at).toISOString();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class PoolLine extends DurableObject<Env> {
  private readonly settings = poolSettings(this.env);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), home TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS hosts (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ready_at INTEGER,
      checked_at INTEGER,
      load TEXT,
      high_since INTEGER,
      low_since INTEGER,
      missed INTEGER NOT NULL DEFAULT 0
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS chats (chat TEXT PRIMARY KEY, host TEXT NOT NULL, at INTEGER NOT NULL)`);
  }

  private home(home?: string): string {
    const sql = this.ctx.storage.sql;
    const known = sql.exec<{ home: string }>("SELECT home FROM meta WHERE id = 1").toArray()[0]?.home;
    if (home !== undefined && known !== home) sql.exec("INSERT OR REPLACE INTO meta (id, home) VALUES (1, ?)", home);
    return home ?? known ?? "";
  }

  private hosts(): PoolHostRecord[] {
    return this.ctx.storage.sql.exec<HostRow>("SELECT * FROM hosts ORDER BY started_at, id").toArray().map(hostFrom);
  }

  private hostRow(id: string): HostRow | undefined {
    return this.ctx.storage.sql.exec<HostRow>("SELECT * FROM hosts WHERE id = ?", id).toArray()[0];
  }

  private saveHost(host: PoolHostRecord, missed = 0): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO hosts (id, state, started_at, ready_at, checked_at, load, high_since, low_since, missed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      host.id, host.state, host.startedAt, host.readyAt ?? null, host.checkedAt ?? null, host.load ? JSON.stringify(host.load) : null, host.highSince ?? null, host.lowSince ?? null, missed,
    );
  }

  private stub(id: string): DurableObjectStub<PoolHost> {
    return this.env.POOL_HOST.get(this.env.POOL_HOST.idFromName(`pool-host:${this.home()}:${id}`));
  }

  private sticky(chat: string): string | undefined {
    return this.ctx.storage.sql.exec<{ host: string }>("SELECT host FROM chats WHERE chat = ?", chat).toArray()[0]?.host;
  }

  private async addHost(): Promise<PoolHostRecord> {
    const host: PoolHostRecord = { id: newHostId(), state: "starting", startedAt: Date.now() };
    this.saveHost(host);
    console.log(`laterdog computers: [pool] add ${host.id}`);
    await this.stub(host.id).ensure({ id: host.id, home: this.home() });
    await this.arm(Date.now() + 2_000);
    return host;
  }

  private async check(host: PoolHostRecord): Promise<PoolHostRecord | undefined> {
    const status = await this.stub(host.id).status().catch(() => undefined);
    if (status) {
      const next = observe(host, loadFrom(status as AgentStatus), Date.now(), this.settings);
      if (host.state === "starting") console.log(`laterdog computers: [pool] ${host.id} ready after ${next.readyAt! - host.startedAt} ms`);
      this.saveHost(next);
      return next;
    }
    const missed = (this.hostRow(host.id)?.missed ?? 0) + 1;
    this.saveHost(host, missed);
    const late = host.state === "starting" ? Date.now() - host.startedAt > START_PATIENCE_MS : missed >= MISSED_CHECKS_BEFORE_RESTART;
    if (late) {
      console.error(`laterdog computers: [pool] ${host.id} did not answer; starting it again`);
      this.saveHost({ ...host, state: "starting", startedAt: Date.now() }, 0);
      this.ctx.storage.sql.exec("DELETE FROM chats WHERE host = ?", host.id);
      await this.stub(host.id).ensure({ id: host.id, home: this.home() }).catch(() => undefined);
    }
    return undefined;
  }

  private async untilReady(id: string): Promise<PoolHostRecord | undefined> {
    const deadline = Date.now() + START_PATIENCE_MS;
    while (Date.now() < deadline) {
      const row = this.hostRow(id);
      if (!row) return undefined;
      const host = hostFrom(row);
      if (host.state === "ready") return host;
      const checked = await this.check(host);
      if (checked?.state === "ready") return checked;
      await sleep(WAIT_STEP_MS);
    }
    return undefined;
  }

  private async arm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  async open(home: string, spec: EngineSpec, wait = true): Promise<Opened> {
    const began = Date.now();
    this.home(home);
    const skip = new Set<string>();
    let scaledOut = false;
    if (this.hosts().filter((host) => host.state !== "draining").length === 0) {
      await this.addHost();
      scaledOut = true;
    }
    for (let attempt = 0; attempt <= this.settings.maxHosts + 1; attempt++) {
      const hosts = this.hosts();
      let target = place(hosts, spec.chat, this.sticky(spec.chat), skip);
      if (!target.host) {
        const starting = hosts.find((host) => host.state === "starting" && !skip.has(host.id));
        const live = hosts.filter((host) => host.state !== "draining").length;
        const next = starting ?? (live < this.settings.maxHosts ? await this.addHost() : undefined);
        if (!next) break;
        scaledOut ||= !starting;
        if (!wait) return { value: { chat: spec.chat, host: next.id, state: "waking", sticky: false, placeMs: Date.now() - began, scaledOut, stream: streamPath(spec.chat) } };
        const ready = await this.untilReady(next.id);
        if (!ready) {
          skip.add(next.id);
          continue;
        }
        target = { host: ready.id, sticky: false, scaleOut: false };
      }
      const id = target.host!;
      const answer = await this.stub(id).open(spec).catch(() => undefined);
      if (answer && (answer.status === 200 || answer.status === 201)) {
        const engine = answer.body.engine!;
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO chats (chat, host, at) VALUES (?, ?, ?)", spec.chat, id, Date.now());
        const row = this.hostRow(id);
        if (row?.load) {
          const load = JSON.parse(row.load) as HostLoad;
          if (!load.warm.includes(spec.chat)) {
            load.warm.push(spec.chat);
            load.engines += 1;
            load.usedBytes += engine.memoryBytes || load.estimateBytes;
          }
          for (const evicted of engine.evicted) {
            load.warm = load.warm.filter((chat) => chat !== evicted);
            this.ctx.storage.sql.exec("DELETE FROM chats WHERE chat = ? AND host = ?", evicted, id);
          }
          this.ctx.storage.sql.exec("UPDATE hosts SET load = ? WHERE id = ?", JSON.stringify(load), id);
        }
        const warm = answer.status === 200;
        console.log(`laterdog computers: [pool] ${warm ? "warm" : "cold"} ${spec.chat} on ${id} in ${Date.now() - began} ms${target.sticky && warm ? " (sticky)" : ""}`);
        await this.arm(Date.now() + CHECK_MS);
        const now = this.hosts();
        const live = now.filter((host) => host.state !== "draining");
        if (!now.some((host) => host.state === "starting") && live.length < this.settings.maxHosts && nearlyFull(live.filter((host) => host.state === "ready"))) {
          void this.addHost().catch(() => undefined);
          scaledOut = true;
        }
        return { value: { chat: spec.chat, host: id, state: warm ? "warm" : "cold", sticky: target.sticky && warm, placeMs: Date.now() - began, engine, scaledOut, stream: streamPath(spec.chat) } };
      }
      if (answer && answer.status === 400) {
        const error = answer.body.error;
        return { refusal: { status: 400, code: error?.code ?? "invalid_engine", message: error?.message ?? "The engine request was refused." } };
      }
      skip.add(id);
      if (answer?.status === 503) {
        const host = this.hostRow(id);
        if (host) await this.check(hostFrom(host));
      }
    }
    return { refusal: { status: 503, code: "pool_full", message: "Every pool host is full and the pool is at its largest size; try again shortly." } };
  }

  async hostFor(chat: string): Promise<{ host: string; name: string } | undefined> {
    const host = this.sticky(chat);
    if (!host || !this.hostRow(host)) return undefined;
    return { host, name: `pool-host:${this.home()}:${host}` };
  }

  async close(chat: string): Promise<boolean> {
    const host = this.sticky(chat);
    if (!host) return false;
    this.ctx.storage.sql.exec("DELETE FROM chats WHERE chat = ?", chat);
    const answer = await this.stub(host).close(chat).catch(() => undefined);
    return answer?.status === 200;
  }

  async view(home: string, detail = false): Promise<PoolView> {
    this.home(home);
    const hosts = this.hosts();
    const agents: Record<string, AgentStatus | null> = {};
    if (detail) for (const host of hosts) agents[host.id] = (await this.stub(host.id).status().catch(() => undefined)) ?? null;
    const chats = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM chats").one().count;
    return {
      settings: this.settings,
      hosts: hosts.map((host) => ({
        id: host.id,
        state: host.state,
        face: faceOf(host.state),
        startedAt: iso(host.startedAt),
        ...(host.readyAt === undefined ? {} : { readyAt: iso(host.readyAt), bootMs: host.readyAt - host.startedAt }),
        ...(host.load ? { load: host.load } : {}),
        hourlyUsd: Math.round(hostHourlyUsd(host.load?.cpuShare ?? 0) * 1000) / 1000,
      })),
      chats,
      hourlyUsd: hourlyCost(hosts),
      ...(detail ? { agents } : {}),
    };
  }

  async start(home: string): Promise<PoolView> {
    this.home(home);
    if (this.hosts().filter((host) => host.state !== "draining").length === 0) await this.addHost();
    await this.arm(Date.now() + 2_000);
    return this.view(home);
  }

  async stop(home: string): Promise<PoolView> {
    this.home(home);
    for (const host of this.hosts()) await this.stub(host.id).remove().catch(() => undefined);
    this.ctx.storage.sql.exec("DELETE FROM hosts");
    this.ctx.storage.sql.exec("DELETE FROM chats");
    await this.ctx.storage.deleteAlarm();
    console.log("laterdog computers: [pool] stopped");
    return this.view(home);
  }

  async reconcile(): Promise<void> {
    if (this.hosts().length === 0 && !this.home()) return;
    for (const host of this.hosts()) await this.check(host);
    const plan = planScale(this.hosts(), Date.now(), this.settings);
    for (let added = 0; added < plan.add; added++) await this.addHost();
    for (const id of plan.drain) {
      this.ctx.storage.sql.exec("UPDATE hosts SET state = 'draining' WHERE id = ?", id);
      console.log(`laterdog computers: [pool] drain ${id}`);
    }
    for (const id of plan.remove) {
      await this.stub(id).remove().catch(() => undefined);
      this.ctx.storage.sql.exec("DELETE FROM hosts WHERE id = ?", id);
      this.ctx.storage.sql.exec("DELETE FROM chats WHERE host = ?", id);
      console.log(`laterdog computers: [pool] remove ${id}`);
    }
    if (this.hosts().length > 0) await this.ctx.storage.setAlarm(Date.now() + (this.hosts().some((host) => host.state === "starting") ? 2_000 : CHECK_MS));
  }

  override async alarm(): Promise<void> {
    await this.reconcile();
  }
}
